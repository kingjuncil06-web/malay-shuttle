import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
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
    private static final String SEATS = PREFIX + "taken";
    private static final String UPDATED_AT = PREFIX + "updated-at";
    private static final String ALERTS = PREFIX + "alerts";
    private static final long ALERT_LIFETIME = Duration.ofMinutes(30).toMillis();
    private static final String DRIVER_CODE = System.getenv().getOrDefault("SHUTTLE_DRIVER_CODE", "");
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
        local alerts = activeAlerts(KEYS[1], tonumber(ARGV[3]))
        local incoming = cjson.decode(ARGV[2])
        for _, value in ipairs(alerts) do
            local alert = cjson.decode(value)
            if alert.stop == incoming.stop and alert.normalizedName == incoming.normalizedName then
                return 1
            end
        end
        if #alerts >= 100 then return 0 end
        redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
        return 1
        """;

    private record SeatStatus(int taken, int available, List<String> stops, Long updatedAt) {}
    private record Dashboard(SeatStatus status, List<PickupAlert> alerts) {}
    private record StoredAlert(String id, String name, String stop, String normalizedName, long createdAt) {}
    private record PickupAlert(String id, String name, String stop) {}

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
            case "/api/status" -> status(exchange, method);
            case "/api/alerts" -> alerts(exchange, method);
            case "/api/dashboard" -> dashboard(exchange);
            case "/api/trip/end" -> endTrip(exchange);
            default -> {
                if (!path.startsWith("/api/alerts/")) throw new ApiError(404, "Page not found");
                requireMethod(exchange, "DELETE");
                requireDriver(exchange);
                String id = path.substring("/api/alerts/".length());
                if (!id.matches("(?i)[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
                    throw new ApiError(400, "Invalid alert ID");
                }
                redis("HDEL", ALERTS, id);
                exchange.sendResponseHeaders(204, -1);
            }
        }
    }

    private static void status(HttpExchange exchange, String method) throws IOException, InterruptedException {
        requireMethod(exchange, "GET", "PUT");
        if (method.equals("GET")) {
            sendJson(exchange, 200, readStatus(redis("MGET", SEATS, UPDATED_AT)));
        } else {
            requireDriver(exchange);
            int taken;
            JsonElement value = readBody(exchange).get("taken");
            try {
                if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
                    throw new NumberFormatException();
                }
                taken = value.getAsBigDecimal().intValueExact();
            } catch (ArithmeticException | NumberFormatException error) {
                throw new ApiError(400, "Invalid seat count");
            }
            if (taken < 0 || taken > CAPACITY) throw new ApiError(400, "Invalid seat count");
            long now = System.currentTimeMillis();
            redis("MSET", SEATS, taken, UPDATED_AT, now);
            sendJson(exchange, 200, new SeatStatus(taken, CAPACITY - taken, STOPS, now));
        }
    }

    private static SeatStatus readStatus(JsonElement result) {
        var values = result.getAsJsonArray();
        int taken = values.get(0).isJsonNull() ? 0 : values.get(0).getAsInt();
        Long updatedAt = values.get(1).isJsonNull() ? null : values.get(1).getAsLong();
        return new SeatStatus(taken, CAPACITY - taken, STOPS, updatedAt);
    }

    private static void dashboard(HttpExchange exchange) throws IOException, InterruptedException {
        requireMethod(exchange, "GET");
        requireDriver(exchange);
        var snapshot = redis("EVAL", PRUNE_ALERTS + """
            return {redis.call("MGET", KEYS[1], KEYS[2]), activeAlerts(KEYS[3], tonumber(ARGV[1]))}
            """, 3, SEATS, UPDATED_AT, ALERTS, System.currentTimeMillis() - ALERT_LIFETIME).getAsJsonArray();
        sendJson(exchange, 200, new Dashboard(readStatus(snapshot.get(0)), readAlerts(snapshot.get(1))));
    }

    private static void endTrip(HttpExchange exchange) throws IOException, InterruptedException {
        requireMethod(exchange, "POST");
        requireDriver(exchange);
        long now = System.currentTimeMillis();
        redis("EVAL", """
            redis.call("MSET", KEYS[1], 0, KEYS[2], ARGV[1])
            return redis.call("DEL", KEYS[3])
            """, 3, SEATS, UPDATED_AT, ALERTS, now);
        sendJson(exchange, 200, new SeatStatus(0, CAPACITY, STOPS, now));
    }

    private static void alerts(HttpExchange exchange, String method) throws IOException, InterruptedException {
        requireMethod(exchange, "GET", "POST");
        if (method.equals("GET")) {
            requireDriver(exchange);
            var active = redis("EVAL", PRUNE_ALERTS + "return activeAlerts(KEYS[1], tonumber(ARGV[1]))",
                1, ALERTS, System.currentTimeMillis() - ALERT_LIFETIME);
            sendJson(exchange, 200, readAlerts(active));
            return;
        }

        JsonObject body = readBody(exchange);
        String name = stringField(body, "name").strip();
        String stop = stringField(body, "stop");
        if (name.isEmpty() || name.length() > 60 || !STOPS.contains(stop)) {
            throw new ApiError(400, "Invalid name or pickup point");
        }
        String id = UUID.randomUUID().toString();
        long now = System.currentTimeMillis();
        var alert = new StoredAlert(id, name, stop, name.toLowerCase(Locale.ROOT), now);
        if (redis("EVAL", SAVE_ALERT, 1, ALERTS, id, JSON.toJson(alert), now - ALERT_LIFETIME).getAsInt() == 0) {
            throw new ApiError(429, "Pickup alert list is full");
        }
        exchange.sendResponseHeaders(204, -1);
    }

    private static List<PickupAlert> readAlerts(JsonElement result) {
        List<StoredAlert> pending = new ArrayList<>();
        for (JsonElement value : result.getAsJsonArray()) {
            pending.add(JSON.fromJson(value.getAsString(), StoredAlert.class));
        }
        pending.sort(Comparator.comparingLong(StoredAlert::createdAt));
        return pending.stream().map(alert -> new PickupAlert(alert.id(), alert.name(), alert.stop())).toList();
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
        if (response.statusCode() != 200) throw new IOException("Redis request failed");
        JsonObject body = JSON.fromJson(response.body(), JsonObject.class);
        if (body == null || body.has("error") || !body.has("result")) {
            throw new IOException("Redis command failed");
        }
        return body.get("result");
    }

    private static void requireDriver(HttpExchange exchange) {
        String code = exchange.getRequestHeaders().getFirst("X-Driver-Code");
        if (DRIVER_CODE.isBlank() || code == null || !MessageDigest.isEqual(bytes(DRIVER_CODE), bytes(code))) {
            throw new ApiError(403, "Check the driver code");
        }
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
