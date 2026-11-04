import { createHash, timingSafeEqual } from "node:crypto";

export const CAPACITY = 15;
export const STOPS = [
    "Pacita Astrodome", "Ukay-Ukay beside Savemore", "Uncle John's Maria Aurora", "Southwoods"
];
const scope = process.env.VERCEL_ENV || "development";
export const SEATS = `malay-shuttle:${scope}:taken`;
export const ALERTS = `malay-shuttle:${scope}:alerts`;

export function json(data, status = 200, headers = {}) {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function empty() {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function redis(...command) {
    const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
    if (!url || !token) throw new Error("Redis credentials are missing");
    const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error("Redis request failed");
    const { result, error } = await response.json();
    if (error) throw new Error("Redis command failed");
    return result;
}

export function endpoint(methods, driverMethods = []) {
    return {
        async fetch(request) {
            const { method } = request;
            if (!Object.hasOwn(methods, method)) {
                return json({ error: "Method not allowed" }, 405, { Allow: Object.keys(methods).join(", ") });
            }

            if (driverMethods.includes(method)) {
                const expected = process.env.SHUTTLE_DRIVER_CODE;
                const code = request.headers.get("X-Driver-Code");
                const digest = value => createHash("sha256").update(value).digest();
                if (!expected?.trim() || !code || !timingSafeEqual(digest(expected), digest(code))) {
                    return json({ error: "Check the driver code" }, 403);
                }
            }

            try {
                return await methods[method](request);
            } catch {
                return json({ error: "Shuttle data is temporarily unavailable" }, 503);
            }
        }
    };
}
