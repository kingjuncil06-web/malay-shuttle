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
async function call(path, method = "GET", body, session, shuttle = 1, cookie) {
    const response = await fetch(base + "/api" + path, {
        method, headers: { "X-Shuttle-Id": String(shuttle), ...(session ? { "X-Driver-Session": session } : {}),
            ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    return { code: response.status, body: response.status === 204 ? null : await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function newPassenger() {
    const response = await call("/passenger");
    assert.equal(response.code, 200);
    assert.ok(response.cookie?.startsWith("ms_passenger="));
    return response.cookie;
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
    const result = await call("/alerts", "POST", { name, stop: "Southwoods", operationId: randomUUID() },
        undefined, 1, await newPassenger());
    assert.equal(result.code, 201, JSON.stringify(result.body));
    return result.body.active.receipt;
}
try {
    const [line] = await Promise.race([
        once(createInterface({ input: app.stdout }), "line"),
        once(app, "exit").then(() => { throw new Error("Java server exited before starting."); })
    ]);
    base = "http://127.0.0.1:" + line.split(" ").at(-1);
    assert.equal((await call("/alerts", "POST", { name: "Test", stop: "Southwoods", operationId: randomUUID() },
        undefined, 1, await newPassenger())).code, 409);
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

    const browser = await newPassenger();
    const submit = { name: "Same name", stop: "Southwoods", operationId: randomUUID() };
    const first = await call("/alerts", "POST", submit, undefined, 1, browser);
    assert.equal(first.code, 201, JSON.stringify(first.body));
    const active = first.body.active;
    assert.equal(first.body.changed, true);
    assert.equal(active.shuttleId, 1);
    assert.ok(active.expiresAt - first.body.serverTime === 300000);
    const retry = await call("/alerts", "POST", submit, undefined, 1, browser);
    assert.equal(retry.body.active.alertId, active.alertId);
    assert.equal((await call("/alerts", "POST", { ...submit, name: "Different name", operationId: randomUUID() },
        undefined, 3, browser)).code, 409, "Changing names or shuttles must not bypass one active ping.");
    const cookieRead = await call("/passenger", "GET", undefined, undefined, 1, "theme=light; " + browser);
    assert.equal(cookieRead.body.active.alertId, active.alertId);
    assert.equal(cookieRead.cookie, undefined, "The browser ID must survive unrelated cookies and reloads.");
    assert.equal((await call("/passenger/confirm", "POST", { alertId: active.alertId },
        undefined, 1, browser)).code, 429);
    const otherBrowser = await newPassenger();
    const sameName = await call("/alerts", "POST", { ...submit, operationId: randomUUID() },
        undefined, 1, otherBrowser);
    assert.equal(sameName.code, 201, "Different passengers with the same name must both be allowed.");
    assert.notEqual(sameName.body.active.receipt, active.receipt);
    assert.equal((await call("/passenger/cancel", "POST", { alertId: active.alertId },
        undefined, 1, otherBrowser)).code, 409);
    assert.equal((await call("/passenger/cancel", "POST", { alertId: active.alertId })).code, 403);

    const browserId = browser.split("=")[1];
    const pointerKey = prefix + "passenger:" + browserId;
    const pointer = JSON.parse(await redis("GET", pointerKey));
    pointer.confirmedAt -= 61000;
    await redis("SET", pointerKey, JSON.stringify(pointer), "PX", 300000);
    const confirmed = await call("/passenger/confirm", "POST", { alertId: active.alertId },
        undefined, 1, browser);
    assert.equal(confirmed.code, 200);
    assert.equal(confirmed.body.changed, true);
    assert.ok(confirmed.body.active.confirmedAt > pointer.confirmedAt);
    assert.equal(confirmed.body.active.expiresAt - confirmed.body.serverTime, 300000);
    const cancelled = await call("/passenger/cancel", "POST", { alertId: active.alertId },
        undefined, 1, browser);
    assert.equal(cancelled.code, 200);
    assert.equal(cancelled.body.changed, true);
    assert.equal(cancelled.body.active, undefined);
    assert.ok(cancelled.body.cooldownUntil > cancelled.body.serverTime);
    const cancelledAgain = await call("/passenger/cancel", "POST", { alertId: active.alertId },
        undefined, 1, browser);
    assert.equal(cancelledAgain.code, 200);
    assert.equal(cancelledAgain.body.changed, false);
    assert.equal((await call("/alerts", "POST", { ...submit, operationId: randomUUID() },
        undefined, 1, browser)).code, 429, "Cancellation must retain the cooldown.");
    assert.equal((await call("/passenger", "GET", undefined, undefined, 1, otherBrowser))
        .body.active.alertId, sameName.body.active.alertId);
    await redis("DEL", prefix + "cooldown:" + browserId);
    const oldRetry = await call("/alerts", "POST", submit, undefined, 1, browser);
    assert.equal(oldRetry.body.active, undefined, "Retrying a completed submission must not recreate it.");
    const simultaneous = await Promise.all([1, 2].map(index =>
        call("/alerts", "POST", { ...submit, name: "Concurrent " + index, operationId: randomUUID() },
            undefined, 1, browser)));
    assert.deepEqual(simultaneous.map(result => result.code).sort(), [201, 409]);

    const expiring = simultaneous.find(result => result.code === 201).body.active;
    const stale = JSON.parse(await redis("GET", pointerKey));
    stale.expiresAt = Date.now() - 1;
    const alert = JSON.parse(await redis("HGET", prefix + "alerts", expiring.alertId));
    alert.expiresAt = stale.expiresAt;
    await redis("SET", pointerKey, JSON.stringify(stale), "PX", 300000);
    await redis("HSET", prefix + "alerts", expiring.alertId, JSON.stringify(alert));
    assert.equal((await call("/passenger", "GET", undefined, undefined, 1, browser)).body.active, undefined);
    const finalLogin = await call("/driver/session", "POST", { code: "test-code-1" });
    const expiredDashboard = await dashboard(finalLogin.body.token);
    assert.ok(!expiredDashboard.alerts.some(entry => entry.id === expiring.alertId));
    console.log("Real Redis tests passed for driver safety and passenger identity, cooldown, cancellation, reconfirmation, expiry, retry safety, and concurrent pings.");
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
