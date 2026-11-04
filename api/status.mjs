import { CAPACITY, STOPS, SEATS, endpoint, json, redis } from "../lib/shuttle.mjs";

function status(taken) {
    return json({ taken, available: CAPACITY - taken, stops: STOPS });
}

export default endpoint({
    async GET() {
        return status(Number(await redis("GET", SEATS)));
    },
    async PUT(request) {
        const body = await request.json().catch(() => null);
        const taken = body?.taken;
        if (!Number.isInteger(taken) || taken < 0 || taken > CAPACITY) {
            return json({ error: "Invalid seat count" }, 400);
        }
        await redis("SET", SEATS, taken);
        return status(taken);
    }
}, ["PUT"]);
