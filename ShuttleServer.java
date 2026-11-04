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
    private static final String ALERTS = PREFIX + "alerts";
    private static final String DRIVER_CODE = System.getenv().getOrDefault("SHUTTLE_DRIVER_CODE", "");
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3)).build();

    // Deduplication, the capacity check, and the write run together in Redis.
    private static final String SAVE_ALERT = """
        local alerts = redis.call("HVALS", KEYS[1])
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
                switch (path) {
                    case "/api/status" -> status(exchange, method);
                    case "/api/alerts" -> alerts(exchange, method);
                    default -> {
                        if (path.startsWith("/api/alerts/")) {
                            requireMethod(exchange, "DELETE");
                            requireDriver(exchange);
                            String id = path.substring("/api/alerts/".length());
                            if (!id.matches("(?i)[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
                                throw new ApiError(400, "Invalid alert ID");
                            }
                            redis("HDEL", ALERTS, id);
                            exchange.sendResponseHeaders(204, -1);
                        } else {
                            throw new ApiError(404, "Page not found");
                        }
                    }
                }
            } catch (ApiError error) {
                sendJson(exchange, error.status, Map.of("error", error.getMessage()));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                sendJson(exchange, 503, Map.of("error", "Shuttle data is temporarily unavailable"));
            } catch (IOException | RuntimeException error) {
                sendJson(exchange, 503, Map.of("error", "Shuttle data is temporarily unavailable"));
            }
        }
    }

    private static void status(HttpExchange exchange, String method) throws IOException, InterruptedException {
        requireMethod(exchange, "GET", "PUT");
        int taken;
        if (method.equals("PUT")) {
            requireDriver(exchange);
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
            redis("SET", SEATS, taken);
        } else {
            JsonElement value = redis("GET", SEATS);
            taken = value.isJsonNull() ? 0 : value.getAsInt();
        }
        sendJson(exchange, 200, Map.of("taken", taken, "available", CAPACITY - taken, "stops", STOPS));
    }

    private static void alerts(HttpExchange exchange, String method) throws IOException, InterruptedException {
        requireMethod(exchange, "GET", "POST");
        if (method.equals("GET")) {
            requireDriver(exchange);
            List<StoredAlert> pending = new ArrayList<>();
            for (JsonElement value : redis("HVALS", ALERTS).getAsJsonArray()) {
                pending.add(JSON.fromJson(value.getAsString(), StoredAlert.class));
            }
            pending.sort(Comparator.comparingLong(StoredAlert::createdAt));
            sendJson(exchange, 200, pending.stream()
                .map(alert -> new PickupAlert(alert.id(), alert.name(), alert.stop())).toList());
            return;
        }

        JsonObject body = readBody(exchange);
        String name = stringField(body, "name").strip();
        String stop = stringField(body, "stop");
        if (name.isEmpty() || name.length() > 60 || !STOPS.contains(stop)) {
            throw new ApiError(400, "Invalid name or pickup point");
        }
        String id = UUID.randomUUID().toString();
        var alert = new StoredAlert(id, name, stop, name.toLowerCase(Locale.ROOT), System.currentTimeMillis());
        if (redis("EVAL", SAVE_ALERT, 1, ALERTS, id, JSON.toJson(alert)).getAsInt() == 0) {
            throw new ApiError(429, "Pickup alert list is full");
        }
        exchange.sendResponseHeaders(204, -1);
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
