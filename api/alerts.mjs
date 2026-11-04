import { randomUUID } from "node:crypto";
import { ALERTS, STOPS, empty, endpoint, json, redis } from "../lib/shuttle.mjs";

// Check for duplicates and the alert limit in the same atomic operation as the write.
const saveAlert = `
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
`;

export default endpoint({
    async GET() {
        const values = await redis("HVALS", ALERTS);
        const alerts = values.map(value => JSON.parse(value));
        alerts.sort((a, b) => a.createdAt - b.createdAt);
        return json(alerts.map(({ id, name, stop }) => ({ id, name, stop })));
    },
    async POST(request) {
        const body = await request.json().catch(() => null);
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        const stop = body?.stop;
        if (!name || name.length > 60 || !STOPS.includes(stop)) {
            return json({ error: "Invalid name or pickup point" }, 400);
        }
        const id = randomUUID();
        const alert = { id, name, stop, normalizedName: name.toLowerCase(), createdAt: Date.now() };
        const saved = await redis("EVAL", saveAlert, 1, ALERTS, id, JSON.stringify(alert));
        return saved ? empty() : json({ error: "Pickup alert list is full" }, 429);
    },
    async DELETE(request) {
        const id = new URL(request.url).searchParams.get("id");
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Invalid alert ID" }, 400);
        await redis("HDEL", ALERTS, id);
        return empty();
    }
}, ["GET", "DELETE"]);
