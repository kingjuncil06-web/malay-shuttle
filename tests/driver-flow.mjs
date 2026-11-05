import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: token } = process.env;
assert.ok(url && token, "Set the two Upstash test connection environment variables.");
const scope = "test-" + randomUUID();
const prefix = "malay-shuttle:" + scope + ":";
async function redis(...command) {
    const response = await fetch(url, {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(command), signal: AbortSignal.timeout(10000)
    });
    const body = await response.json();
    assert.ok(!body.error, body.error);
    return body.result;
}

const app = spawn("java", ["-cp", "target/java-check" + (process.platform === "win32" ? ";" : ":") +
    "target/gson.jar", "ShuttleServer"], {
    env: { ...process.env, PORT: "0", VERCEL_ENV: scope, SHUTTLE_DRIVER_CODE_1: "test-code-1",
        SHUTTLE_DRIVER_CODE_2: "test-code-2", SHUTTLE_DRIVER_CODE_3: "test-code-3" },
    stdio: ["ignore", "pipe", "inherit"], windowsHide: true
});
let base;
async function call(path, method = "GET", body, session, shuttle = 1) {
    const response = await fetch(base + "/api" + path, {
        method, headers: { "X-Shuttle-Id": String(shuttle), ...(session ? { "X-Driver-Session": session } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    return { code: response.status, body: response.status === 204 ? null : await response.json() };
}
function action(status, name, fields = {}) {
    return { action: name, tripId: status.tripId, version: String(status.version),
        operationId: randomUUID(), ...fields };
}
async function dashboard(session, shuttle = 1) {
    const response = await call("/dashboard", "GET", undefined, session, shuttle);
    assert.equal(response.code, 200, JSON.stringify(response.body));
    return response.body;
}
async function mutate(session, body, shuttle = 1) {
    const result = await call("/driver/action", "POST", body, session, shuttle);
    assert.equal(result.code, 200, JSON.stringify(result.body));
    return result.body;
}
async function ping(name = "Test passenger") {
    const result = await call("/alerts", "POST", { name, stop: "Southwoods" });
    assert.equal(result.code, 201, JSON.stringify(result.body));
    return result.body.receipt;
}
try {
    const [line] = await Promise.race([
        once(createInterface({ input: app.stdout }), "line"),
        once(app, "exit").then(() => { throw new Error("Java server exited before starting."); })
    ]);
    base = "http://127.0.0.1:" + line.split(" ").at(-1);
    assert.equal((await call("/alerts", "POST", { name: "Test", stop: "Southwoods" })).code, 409);
    assert.equal((await call("/driver/session", "POST", { code: "incorrect" })).code, 403);
    const login = await call("/driver/session", "POST", { code: "test-code-1" });
    assert.equal(login.code, 200, JSON.stringify(login.body));
    let session = login.body.token;
    assert.equal((await call("/dashboard", "GET", undefined, session, 2)).code, 403);
    assert.equal((await call("/driver/session", "POST", { code: "test-code-1" })).code, 409);
    let state = await dashboard(session);
    assert.equal(state.status.running, false);
    const starting = action(state.status, "start", { value: 2 });
    state = await mutate(session, starting);
    assert.equal(state.status.running, true);
    assert.equal(state.status.taken, 2);
    const adjustment = action(state.status, "adjust", { value: 1 });
    const before = state.status;
    state = await mutate(session, adjustment);
    state = await mutate(session, adjustment);
    assert.equal(state.status.taken, 3, "Retry must not add a second seat.");
    assert.equal((await call("/driver/action", "POST", { ...adjustment, value: -1 }, session)).code, 409);
    assert.equal((await call("/driver/action", "POST", action(before, "set", { value: 8 }), session)).code, 409);

    const receipt = await ping();
    state = await dashboard(session);
    assert.equal(state.alerts.length, 1);
    state = await mutate(session, action(state.status, "acknowledge", { alertId: state.alerts[0].id }));
    assert.equal(state.alerts[0].acknowledged, true);
    let replies = await call("/pickup-replies", "POST", { receipts: [receipt] });
    assert.match(replies.body[receipt], /acknowledged/);
    const boarding = action(state.status, "board", { alertId: state.alerts[0].id });
    state = await mutate(session, boarding);
    state = await mutate(session, boarding);
    assert.equal(state.status.taken, 4);
    assert.equal(state.alerts.length, 0);
    replies = await call("/pickup-replies", "POST", { receipts: [receipt] });
    assert.match(replies.body[receipt], /Boarding recorded/);
    assert.ok(!JSON.stringify(state.history).includes("Test passenger"));

    const endedReceipt = await ping("Second test passenger");
    const prior = state.status;
    state = await mutate(session, action(state.status, "end"));
    assert.equal(state.status.running, false);
    assert.equal(state.status.taken, 0);
    assert.equal(state.alerts.length, 0);
    replies = await call("/pickup-replies", "POST", { receipts: [endedReceipt] });
    assert.match(replies.body[endedReceipt], /trip has ended/);
    assert.equal((await call("/driver/action", "POST", action(prior, "set", { value: 9 }), session)).code, 409);

    const takeover = await call("/driver/session", "POST", { code: "test-code-1", takeover: true });
    assert.equal(takeover.code, 200);
    assert.equal((await call("/dashboard", "GET", undefined, session)).code, 403);
    session = takeover.body.token;
    state = await dashboard(session);
    state = await mutate(session, action(state.status, "start", { value: 15 }));
    assert.equal((await call("/driver/action", "POST", action(state.status, "adjust", { value: 1 }), session)).code, 409);
    assert.equal((await call("/driver/session", "DELETE", undefined, session)).code, 204);
    assert.equal((await call("/dashboard", "GET", undefined, session)).code, 403);
    for (let i = 0; i < 10; i++) assert.equal((await call("/driver/session", "POST", { code: "wrong" }, undefined, 2)).code, 403);
    assert.equal((await call("/driver/session", "POST", { code: "test-code-2" }, undefined, 2)).code, 429);
    assert.deepEqual((await call("/shuttles")).body.map(entry => entry.status.taken), [15, 0, 0]);
    console.log("Real Redis driver tests passed: sessions, takeover, trips, stale updates, retry safety, boarding, replies, limits, and shuttle isolation.");
} finally {
    app.kill();
    let cursor = "0";
    do {
        const page = await redis("SCAN", cursor, "MATCH", prefix + "*", "COUNT", 100);
        cursor = page[0];
        const keys = page[1];
        assert.ok(keys.every(key => key.startsWith(prefix)));
        if (keys.length) await redis("DEL", ...keys);
    } while (cursor !== "0");
}
