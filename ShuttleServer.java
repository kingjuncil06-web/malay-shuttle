import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.Strictness;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

public class ShuttleServer {
    private static final int CAPACITY = 15;
    private static final List<String> STOPS = List.of(
        "Pacita Astrodome", "Ukay-Ukay beside Savemore", "Uncle John's Maria Aurora", "Southwoods"
    );
    private static final Gson JSON = new GsonBuilder().setStrictness(Strictness.STRICT).create();
    private static final String PREFIX = "malay-shuttle:"
        + System.getenv().getOrDefault("VERCEL_ENV", "development") + ":";
    private static final String REPLIES = PREFIX + "reply:";
    private static final String UUID_PATTERN = "[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}";
    private static final int MAX_RECEIPTS = 10;
    private static final long ALERT_LIFETIME = Duration.ofMinutes(30).toMillis();
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3)).build();

    private static final String PRUNE_ALERTS = """
        local function activeAlerts(key, cutoff)
            local entries = redis.call("HGETALL", key)
            local active = {}
            for i = 1, #entries, 2 do
                if cjson.decode(entries[i + 1]).createdAt <= cutoff then
                    redis.call("HDEL", key, entries[i])
                else
                    active[#active + 1] = entries[i + 1]
                end
            end
            return active
        end
        """;

    // Expiry, deduplication, the capacity check, and the write run together in Redis.
    private static final String SAVE_ALERT = PRUNE_ALERTS + """
        if redis.call("GET", KEYS[2]) ~= "1" then return redis.error_reply("409:This shuttle is not running") end
        local alerts = activeAlerts(KEYS[1], tonumber(ARGV[3]))
        local incoming = cjson.decode(ARGV[2])
        for _, value in ipairs(alerts) do
            local alert = cjson.decode(value)
            if alert.stop == incoming.stop and alert.normalizedName == incoming.normalizedName then
                return 2
            end
        end
        if #alerts >= 100 then return 0 end
        redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
        return 1
        """;

    private record Shuttle(int id, String name, String plate) {
        String key(String field) {
            return PREFIX + (id == 1 ? "" : "shuttle:" + id + ":") + field;
        }
    }
    private static final List<Shuttle> SHUTTLES = List.of(
        new Shuttle(1, "Shuttle 1", "DEMO-001"),
        new Shuttle(2, "Shuttle 2", "DEMO-002"),
        new Shuttle(3, "Shuttle 3", "DEMO-003")
    );
    private record FleetEntry(Shuttle shuttle, SeatStatus status) {}

    private static Shuttle selectedShuttle(HttpExchange exchange) {
        String id = exchange.getRequestHeaders().getFirst("X-Shuttle-Id");
        if (id == null) return SHUTTLES.getFirst();
        return SHUTTLES.stream().filter(shuttle -> Integer.toString(shuttle.id()).equals(id))
            .findFirst().orElseThrow(() -> new ApiError(400, "Invalid shuttle"));
    }

    private static final String DRIVER_STATE = PRUNE_ALERTS + """

        if redis.call("GET", KEYS[1]) ~= ARGV[1] then return redis.error_reply("403:Driver session expired or taken over") end
        local action, now = ARGV[2], tonumber(ARGV[5])
        local function snapshot()
            return {redis.call("MGET", KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]),
                    activeAlerts(KEYS[7], now - 1800000), redis.call("LRANGE", KEYS[8], 0, 49)}
        end
        if action == "read" then return snapshot() end
        local fingerprint = cjson.encode({action, ARGV[3], ARGV[4], ARGV[6], ARGV[7], ARGV[8]})
        local previous = redis.call("GET", KEYS[9])
        if previous then
            if previous ~= fingerprint then return redis.error_reply("409:Operation ID already used") end
            return snapshot()
        end
        local trip = redis.call("GET", KEYS[4]) or ""
        local version = redis.call("GET", KEYS[6]) or "0"
        local running = redis.call("GET", KEYS[5]) == "1"
        if trip ~= ARGV[3] or version ~= ARGV[4] then
            return redis.error_reply("409:Shuttle changed. Review the refreshed count and try again")
        end
        if action == "start" and running then return redis.error_reply("409:Trip is already running") end
        if action ~= "start" and not running then return redis.error_reply("409:Start a trip first") end
        local taken = tonumber(redis.call("GET", KEYS[2]) or "0")
        local updateSeats = false
        local function reply(id, alert, message)
            if alert.receipt then
                redis.call("SET", ARGV[9] .. id, cjson.encode({
                    receipt = alert.receipt, stop = alert.stop, message = ARGV[10] .. ": " .. message
                }), "PX", 1800000)
            end
        end
        if action == "start" then
            taken = tonumber(ARGV[6])
            redis.call("MSET", KEYS[4], ARGV[8], KEYS[5], "1")
            updateSeats = true
        elseif action == "end" then
            local entries = redis.call("HGETALL", KEYS[7])
            for i = 1, #entries, 2 do
                local alert = cjson.decode(entries[i + 1])
                if alert.createdAt > now - 1800000 then reply(entries[i], alert, "The trip has ended.") end
            end
            taken = 0
            redis.call("SET", KEYS[5], "0")
            redis.call("DEL", KEYS[7])
            updateSeats = true
        elseif action == "set" or action == "adjust" then
            taken = action == "set" and tonumber(ARGV[6]) or taken + tonumber(ARGV[6])
            if taken < 0 or taken > 15 then return redis.error_reply("409:Seat count must stay between 0 and 15") end
            updateSeats = true
        else
            local value = redis.call("HGET", KEYS[7], ARGV[7])
            if not value then return redis.error_reply("404:This ping is no longer available") end
            local alert = cjson.decode(value)
            if alert.createdAt <= now - 1800000 then
                redis.call("HDEL", KEYS[7], ARGV[7])
                return redis.error_reply("404:This ping has expired")
            end
            if action == "board" then
                if taken >= 15 then return redis.error_reply("409:Shuttle is full. Correct the seat count first") end
                taken = taken + 1
                updateSeats = true
                reply(ARGV[7], alert, "Boarding recorded at " .. alert.stop .. ".")
            elseif action == "acknowledge" then
                alert.acknowledged = true
                redis.call("HSET", KEYS[7], ARGV[7], cjson.encode(alert))
                reply(ARGV[7], alert, "Your pickup request at " .. alert.stop .. " was acknowledged.")
            elseif action == "decline" then
                reply(ARGV[7], alert, "The driver cannot pick you up at " .. alert.stop .. ".")
            elseif action == "absent" then
                reply(ARGV[7], alert, "No passenger was found at " .. alert.stop .. ".")
            end
            if action ~= "acknowledge" then redis.call("HDEL", KEYS[7], ARGV[7]) end
        end
        if updateSeats then redis.call("MSET", KEYS[2], taken, KEYS[3], now) end
        redis.call("INCR", KEYS[6])
        redis.call("LPUSH", KEYS[8], cjson.encode({action = action, time = now, session = ARGV[11], taken = taken}))
        redis.call("LTRIM", KEYS[8], 0, 49)
        redis.call("EXPIRE", KEYS[8], 604800)
        redis.call("SET", KEYS[9], fingerprint, "EX", 86400)
        return snapshot()
        """;

    private record SeatStatus(int taken, int available, List<String> stops, Long updatedAt,
                              String tripId, boolean running, long version) {}
    private record HistoryEntry(String action, long time, String session, int taken) {}
    private record Dashboard(SeatStatus status, List<PickupAlert> alerts, List<HistoryEntry> history,
                             List<FleetEntry> fleet) {}
    private record StoredAlert(String id, String name, String stop, String normalizedName, long createdAt,
                               String receipt, boolean acknowledged) {}
    private record PickupAlert(String id, String name, String stop, boolean canReply, boolean acknowledged,
                               long createdAt) {}
    private record PickupReply(String receipt, String stop, String message) {}

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", ShuttleServer::handle);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        System.out.println("MALAY-SHUTTLE listening on port " + server.getAddress().getPort());
    }

    private static void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if (!path.startsWith("/api/")) {
                servePage(exchange, path, method);
                return;
            }

            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            try {
                routeApi(exchange, path, method);
            } catch (ApiError error) {
                sendJson(exchange, error.status, Map.of("error", error.getMessage()));
            } catch (InterruptedException | IOException | RuntimeException error) {
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                sendJson(exchange, 503, Map.of("error", "Shuttle data is temporarily unavailable"));
            }
        }
    }

    private static void routeApi(HttpExchange exchange, String path, String method)
            throws IOException, InterruptedException {
        switch (path) {
            case "/api/shuttles" -> fleet(exchange);
            case "/api/status" -> status(exchange);
            case "/api/alerts" -> alerts(exchange, method);
            case "/api/dashboard" -> driverState(exchange, false);
            case "/api/driver/action" -> driverState(exchange, true);
            case "/api/driver/session" -> driverSession(exchange);
            case "/api/pickup-replies" -> pickupReplies(exchange);
            default -> throw new ApiError(404, "Page not found");
        }
    }

    private static void pickupReplies(HttpExchange exchange) throws IOException, InterruptedException {
        requireMethod(exchange, "POST");
        JsonElement value = readBody(exchange).get("receipts");
        if (value == null || !value.isJsonArray()) throw new ApiError(400, "Invalid receipts");
        var receipts = value.getAsJsonArray();
        if (receipts.isEmpty() || receipts.size() > MAX_RECEIPTS) throw new ApiError(400, "Invalid receipts");

        List<String> command = new ArrayList<>();
        command.add("MGET");
        for (JsonElement receipt : receipts) {
            if (!receipt.isJsonPrimitive() || !receipt.getAsJsonPrimitive().isString()
                    || !receipt.getAsString().matches(UUID_PATTERN + "\\." + UUID_PATTERN)) {
                throw new ApiError(400, "Invalid receipt");
            }
            command.add(REPLIES + receipt.getAsString().substring(0, 36));
        }
        var results = redis(command.toArray()).getAsJsonArray();
        Map<String, String> replies = new LinkedHashMap<>();
        for (int i = 0; i < results.size(); i++) {
            if (results.get(i).isJsonNull()) continue;
            var reply = JSON.fromJson(results.get(i).getAsString(), PickupReply.class);
            String receipt = receipts.get(i).getAsString();
            if (MessageDigest.isEqual(bytes(receipt.substring(37)), bytes(reply.receipt()))) {
                replies.put(receipt, reply.message() == null
                    ? "The driver cannot pick you up at " + reply.stop() + "." : reply.message());
            }
        }
        sendJson(exchange, 200, replies);
    }


    private static void driverSession(HttpExchange exchange) throws IOException, InterruptedException {
        Shuttle shuttle = selectedShuttle(exchange);
        requireMethod(exchange, "POST", "DELETE");
        if (exchange.getRequestMethod().equals("DELETE")) {
            redis("EVAL", """
                if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
                return 0
                """, 1, shuttle.key("driver-session"), sessionToken(exchange));
            exchange.sendResponseHeaders(204, -1);
            return;
        }
        JsonObject body = readBody(exchange);
        String expected = System.getenv().getOrDefault("SHUTTLE_DRIVER_CODE_" + shuttle.id(), "");
        if (expected.isBlank()) throw new ApiError(503, "Driver code has not been configured for this shuttle");
        JsonElement failures = redis("GET", shuttle.key("login-attempts"));
        int attempts = failures.isJsonNull() ? 0 : failures.getAsInt();
        if (attempts >= 10) throw new ApiError(429, "Too many code attempts. Wait five minutes");
        if (!MessageDigest.isEqual(bytes(expected), bytes(stringField(body, "code")))) {
            redis("EVAL", """
                local count = redis.call("INCR", KEYS[1])
                if count == 1 then redis.call("EXPIRE", KEYS[1], 300) end
                return count
                """, 1, shuttle.key("login-attempts"));
            throw new ApiError(403, "Incorrect code for this shuttle");
        }
        boolean takeover = body.has("takeover") && body.get("takeover").isJsonPrimitive()
            && body.get("takeover").getAsJsonPrimitive().isBoolean() && body.get("takeover").getAsBoolean();
        String token = UUID.randomUUID().toString();
        String previous = exchange.getRequestHeaders().getFirst("X-Driver-Session");
        int claimed = redis("EVAL", """
            local current = redis.call("GET", KEYS[1])
            if current and current ~= ARGV[2] and ARGV[3] ~= "1" then return 0 end
            redis.call("SET", KEYS[1], ARGV[1], "EX", 28800)
            return 1
            """, 1, shuttle.key("driver-session"), token, previous == null ? "" : previous, takeover ? "1" : "0").getAsInt();
        if (claimed == 0) throw new ApiError(409, "Another device controls this shuttle. Use Take over to continue");
        sendJson(exchange, 200, Map.of("token", token));
    }

    private static String sessionToken(HttpExchange exchange) {
        String token = exchange.getRequestHeaders().getFirst("X-Driver-Session");
        if (token == null || !token.matches(UUID_PATTERN)) throw new ApiError(403, "Unlock this shuttle first");
        return token;
    }

    private static List<String> statusKeys(Shuttle shuttle) {
        return List.of(shuttle.key("taken"), shuttle.key("updated-at"), shuttle.key("trip"),
            shuttle.key("running"), shuttle.key("version"));
    }

    private static List<FleetEntry> fleetData() throws IOException, InterruptedException {
        List<String> command = new ArrayList<>();
        command.add("MGET");
        for (Shuttle shuttle : SHUTTLES) command.addAll(statusKeys(shuttle));
        var values = redis(command.toArray()).getAsJsonArray();
        List<FleetEntry> result = new ArrayList<>();
        for (int i = 0; i < SHUTTLES.size(); i++) {
            var state = new JsonArray();
            for (int j = 0; j < 5; j++) state.add(values.get(i * 5 + j));
            result.add(new FleetEntry(SHUTTLES.get(i), readStatus(state)));
        }
        return result;
    }

    private static void fleet(HttpExchange exchange) throws IOException, InterruptedException {
        requireMethod(exchange, "GET");
        sendJson(exchange, 200, fleetData());
    }

    private static void status(HttpExchange exchange) throws IOException, InterruptedException {
        requireMethod(exchange, "GET");
        List<String> command = new ArrayList<>();
        command.add("MGET");
        command.addAll(statusKeys(selectedShuttle(exchange)));
        sendJson(exchange, 200, readStatus(redis(command.toArray())));
    }

    private static SeatStatus readStatus(JsonElement result) {
        var values = result.getAsJsonArray();
        int taken = values.get(0).isJsonNull() ? 0 : values.get(0).getAsInt();
        Long updatedAt = values.get(1).isJsonNull() ? null : values.get(1).getAsLong();
        String trip = values.get(2).isJsonNull() ? "" : values.get(2).getAsString();
        boolean running = !values.get(3).isJsonNull() && values.get(3).getAsString().equals("1");
        long version = values.get(4).isJsonNull() ? 0 : values.get(4).getAsLong();
        return new SeatStatus(taken, CAPACITY - taken, STOPS, updatedAt, trip, running, version);
    }

    private static void driverState(HttpExchange exchange, boolean mutate) throws IOException, InterruptedException {
        requireMethod(exchange, mutate ? "POST" : "GET");
        Shuttle shuttle = selectedShuttle(exchange);
        String token = sessionToken(exchange);
        JsonObject body = mutate ? readBody(exchange) : new JsonObject();
        String action = mutate ? stringField(body, "action") : "read";
        if (!List.of("read", "start", "end", "set", "adjust", "acknowledge", "board", "decline", "absent").contains(action)
                || (mutate && action.equals("read"))) throw new ApiError(400, "Invalid driver action");
        String operation = mutate ? stringField(body, "operationId") : "read";
        if (mutate && !operation.matches(UUID_PATTERN)) throw new ApiError(400, "Invalid operation ID");
        int value = 0;
        if (List.of("start", "set", "adjust").contains(action)) {
            try {
                JsonElement number = body.get("value");
                if (number == null || !number.isJsonPrimitive() || !number.getAsJsonPrimitive().isNumber()) {
                    throw new NumberFormatException();
                }
                value = number.getAsBigDecimal().intValueExact();
            } catch (ArithmeticException | NumberFormatException error) {
                throw new ApiError(400, "Invalid seat count");
            }
            if ((action.equals("adjust") && value != -1 && value != 1)
                    || (!action.equals("adjust") && (value < 0 || value > CAPACITY))) {
                throw new ApiError(400, "Invalid seat count");
            }
        }
        String alertId = stringField(body, "alertId");
        if (List.of("acknowledge", "board", "decline", "absent").contains(action) && !alertId.matches(UUID_PATTERN)) {
            throw new ApiError(400, "Invalid alert ID");
        }
        String version = stringField(body, "version");
        if (mutate && !version.matches("[0-9]{1,18}")) throw new ApiError(400, "Missing state version");
        String trip = stringField(body, "tripId");
        String nextTrip = action.equals("start") ? operation : "";
        List<Object> command = new ArrayList<>(List.of("EVAL", DRIVER_STATE, 9, shuttle.key("driver-session")));
        command.addAll(statusKeys(shuttle));
        command.addAll(List.of(shuttle.key("alerts"), shuttle.key("history"), shuttle.key("operation:" + operation),
            token, action, trip, version, System.currentTimeMillis(), value, alertId, nextTrip, REPLIES,
            shuttle.name(), sessionReference(token)));
        var snapshot = redis(command.toArray()).getAsJsonArray();
        List<HistoryEntry> history = new ArrayList<>();
        for (JsonElement entry : snapshot.get(2).getAsJsonArray()) {
            history.add(JSON.fromJson(entry.getAsString(), HistoryEntry.class));
        }
        sendJson(exchange, 200, new Dashboard(readStatus(snapshot.get(0)), readAlerts(snapshot.get(1)), history, fleetData()));
    }

    private static String sessionReference(String token) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes(token))).substring(0, 12);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void alerts(HttpExchange exchange, String method) throws IOException, InterruptedException {
        Shuttle shuttle = selectedShuttle(exchange);

        requireMethod(exchange, "POST");
        JsonObject body = readBody(exchange);
        String name = stringField(body, "name").strip();
        String stop = stringField(body, "stop");
        if (name.isEmpty() || name.length() > 60 || !STOPS.contains(stop)) {
            throw new ApiError(400, "Invalid name or pickup point");
        }
        String id = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        String receipt = UUID.randomUUID().toString();
        var alert = new StoredAlert(id, name, stop, name.toLowerCase(Locale.ROOT), now, receipt, false);
        int saved = redis("EVAL", SAVE_ALERT, 2, shuttle.key("alerts"), shuttle.key("running"), id, JSON.toJson(alert), now - ALERT_LIFETIME).getAsInt();
        if (saved == 0) throw new ApiError(429, "Pickup alert list is full");
        if (saved == 2) throw new ApiError(409, "A ping for this name and stop is already pending");
        sendJson(exchange, 201, Map.of("receipt", id + "." + receipt));
    }

    private static List<PickupAlert> readAlerts(JsonElement result) {
        List<StoredAlert> pending = new ArrayList<>();
        for (JsonElement value : result.getAsJsonArray()) {
            pending.add(JSON.fromJson(value.getAsString(), StoredAlert.class));
        }
        pending.sort(Comparator.comparingLong(StoredAlert::createdAt));
        return pending.stream()
            .map(alert -> new PickupAlert(alert.id(), alert.name(), alert.stop(), alert.receipt() != null, alert.acknowledged(), alert.createdAt())).toList();
    }

    private static JsonElement redis(Object... command) throws IOException, InterruptedException {
        String url = System.getenv("UPSTASH_REDIS_REST_URL");
        String token = System.getenv("UPSTASH_REDIS_REST_TOKEN");
        if (url == null || token == null) throw new IOException("Redis credentials are missing");
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(5))
            .header("Authorization", "Bearer " + token)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(command))).build();
        var response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        JsonObject body = JSON.fromJson(response.body(), JsonObject.class);
        if (body != null && body.has("error")) {
            String message = body.get("error").getAsString();
            if (message.matches("(?s).*(400|403|404|409|429):.*")) {
                var matcher = java.util.regex.Pattern.compile("(400|403|404|409|429):(.*)", java.util.regex.Pattern.DOTALL).matcher(message);
                if (matcher.find()) throw new ApiError(Integer.parseInt(matcher.group(1)), matcher.group(2));
            }
        }
        if (body == null || body.has("error") || !body.has("result")) {
            throw new IOException("Redis command failed");
        }
        if (response.statusCode() != 200) throw new IOException("Redis request failed");
        return body.get("result");
    }

    private static void requireMethod(HttpExchange exchange, String... methods) {
        if (!List.of(methods).contains(exchange.getRequestMethod())) {
            exchange.getResponseHeaders().set("Allow", String.join(", ", methods));
            throw new ApiError(405, "Method not allowed");
        }
    }

    private static JsonObject readBody(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readNBytes(4097);
        if (body.length > 4096) throw new ApiError(413, "Request is too large");
        try {
            JsonObject parsed = JSON.fromJson(new String(body, StandardCharsets.UTF_8), JsonObject.class);
            if (parsed != null) return parsed;
        } catch (JsonParseException error) {
            throw new ApiError(400, "Invalid JSON");
        }
        throw new ApiError(400, "Invalid JSON");
    }

    private static String stringField(JsonObject body, String name) {
        JsonElement value = body.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
            ? value.getAsString() : "";
    }

    private static void servePage(HttpExchange exchange, String path, String method) throws IOException {
        String file = path.equals("/") ? "index.html" : path.substring(1);
        String type = switch (file) {
            case "index.html" -> "text/html";
            case "style.css" -> "text/css";
            case "script.js" -> "text/javascript";
            default -> null;
        };
        if (type == null) {
            sendJson(exchange, 404, Map.of("error", "Page not found"));
        } else if (!method.equals("GET") && !method.equals("HEAD")) {
            exchange.getResponseHeaders().set("Allow", "GET, HEAD");
            sendJson(exchange, 405, Map.of("error", "Method not allowed"));
        } else {
            exchange.getResponseHeaders().set("Content-Type", type + "; charset=utf-8");
            byte[] content = Files.readAllBytes(Path.of("public", file));
            exchange.sendResponseHeaders(200, method.equals("HEAD") ? -1 : content.length);
            if (method.equals("GET")) exchange.getResponseBody().write(content);
        }
    }

    private static void sendJson(HttpExchange exchange, int status, Object value) throws IOException {
        byte[] content = bytes(JSON.toJson(value));
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, content.length);
        exchange.getResponseBody().write(content);
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static class ApiError extends RuntimeException {
        final int status;
        ApiError(int status, String message) {
            super(message);
            this.status = status;
        }
    }
}
