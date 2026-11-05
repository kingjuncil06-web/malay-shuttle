const byId = id => document.getElementById(id);
const driver = byId("driver");
const code = byId("code");
const driverShuttle = byId("driver-shuttle");
let selectedStop;
let passengerShuttle = 1;
let fleet = [];
let driverStatus;
let busy = false;
let refreshTimer;
let pendingRefresh;

function readStorage(key, fallback) {
    try {
        return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
    } catch {
        return fallback;
    }
}

function saveStorage(key, value) {
    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
        // The open page still works when browser storage is unavailable.
    }
}

let receipts = readStorage("malay-shuttle-receipts", []);
if (!Array.isArray(receipts)) receipts = [];
receipts = receipts.filter(item => item && typeof item.receipt === "string" && Number.isFinite(item.expiresAt));
let sessions = readStorage("malay-shuttle-driver-sessions", {});
if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) sessions = {};
let pendingAction = readStorage("malay-shuttle-driver-operation", null);

async function request(path, method = "GET", body, shuttleId, signal) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (shuttleId) {
        headers["X-Shuttle-Id"] = String(shuttleId);
        if (sessions[shuttleId]) headers["X-Driver-Session"] = sessions[shuttleId];
    }
    const response = await fetch("/api" + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        cache: "no-store", signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
    });
    if (!response.ok) {
        const details = await response.json().catch(() => ({}));
        const error = new Error(details.error || "The request failed. Please try again.");
        error.status = response.status;
        throw error;
    }
    if (response.status !== 204) return response.json();
}

const views = document.querySelectorAll("[data-view]");
function switchTab(button, buttons) {
    for (const tab of buttons) tab.setAttribute("aria-pressed", String(tab === button));
}
for (const button of views) {
    button.onclick = () => {
        switchTab(button, views);
        for (const tab of views) byId(tab.dataset.view).hidden = tab !== button;
        refresh();
    };
}

function countLabel(status) {
    if (!status.running) return "Not running";
    if (!status.updatedAt || Date.now() - status.updatedAt > 5 * 60000) return "Needs seat confirmation";
    return status.available + " available";
}

function showStatus(status) {
    driverStatus = status;
    byId("taken").textContent = status.taken;
    byId("available").textContent = status.running ? status.available : "—";
    byId("seat-updated").textContent = "Seat count last updated: " +
        (status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Unconfirmed");
    byId("trip-status").textContent = countLabel(status);
    updateControls();
}

function showFleet(entries) {
    fleet = entries;
    if (!byId("fleet").children.length) {
        for (const { shuttle } of entries) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "shuttle-card";
            button.onclick = () => {
                passengerShuttle = shuttle.id;
                byId("ping-message").textContent = "";
                renderFleet();
            };
            byId("fleet").append(button);
            const option = document.createElement("option");
            option.value = shuttle.id;
            option.textContent = shuttle.name;
            driverShuttle.append(option);
        }
        makeStops(entries[0].status.stops);
    }
    renderFleet();
    const selected = fleet.find(entry => entry.shuttle.id === Number(driverShuttle.value));
    byId("driver-plate").textContent = "Sample plate · " + selected.shuttle.plate;
    showStatus(selected.status);
}

function renderFleet() {
    for (const [i, { shuttle, status }] of fleet.entries()) {
        const button = byId("fleet").children[i];
        button.setAttribute("aria-pressed", String(shuttle.id === passengerShuttle));
        button.replaceChildren();
        for (const [tag, text] of [
            ["strong", shuttle.name], ["span", "Sample plate · " + shuttle.plate],
            ["b", countLabel(status)], ["span", status.taken + " of 15 seats taken"],
            ["small", "Updated · " + (status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Unconfirmed")]
        ]) {
            const line = document.createElement(tag);
            line.textContent = text;
            button.append(line);
        }
    }
    const selected = fleet.find(entry => entry.shuttle.id === passengerShuttle);
    byId("ping-target").textContent = "Sending to " + selected.shuttle.name + " · " + selected.shuttle.plate;
    byId("ping-button").disabled = !selectedStop || !selected.status.running;
}

function makeStops(stops) {
    for (const stop of stops) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = stop;
        button.setAttribute("aria-pressed", "false");
        button.onclick = () => {
            switchTab(button, byId("stops").children);
            selectedStop = stop;
            byId("ping-message").textContent = "";
            renderFleet();
        };
        byId("stops").append(button);
    }
}

function updateControls() {
    const unlocked = Boolean(sessions[driverShuttle.value]);
    driverShuttle.disabled = busy;
    for (const button of byId("unlock-form").querySelectorAll("button")) button.disabled = busy;
    byId("release").disabled = busy || !unlocked;
    for (const button of byId("seat-form").querySelectorAll("button")) {
        button.disabled = busy || !unlocked || !driverStatus?.running;
    }
    byId("start-trip").disabled = busy || !unlocked || !driverStatus || driverStatus.running;
    for (const button of byId("alerts").querySelectorAll("button")) {
        button.disabled = busy || !unlocked || !driverStatus?.running;
    }
}

function showAlerts(alerts) {
    const list = byId("alerts");
    list.replaceChildren();
    const groups = new Map();
    for (const alert of alerts) {
        if (!groups.has(alert.stop)) {
            const item = document.createElement("li");
            const heading = document.createElement("strong");
            heading.textContent = alert.stop;
            const passengers = document.createElement("ul");
            item.append(heading, passengers);
            list.append(item);
            groups.set(alert.stop, passengers);
        }
        const item = document.createElement("li");
        const minutes = Math.max(0, Math.floor((Date.now() - alert.createdAt) / 60000));
        item.textContent = alert.name + " · waiting " + minutes + " min" +
            (alert.acknowledged ? " · acknowledged" : "");
        const actions = [["Passenger boarded", "board"], ["Can’t pick up", "decline"],
            ["No passenger found", "absent"]];
        if (!alert.acknowledged) actions.unshift(["Acknowledge", "acknowledge"]);
        for (const [label, action] of actions) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.onclick = () => driverAction(action, { alertId: alert.id });
            item.append(button);
        }
        groups.get(alert.stop).append(item);
    }
    byId("alert-count").textContent = alerts.length ? "(" + alerts.length + ")" : "";
    updateControls();
}

function showDashboard(data) {
    showFleet(data.fleet);
    showStatus(data.status);
    showAlerts(data.alerts);
    byId("alert-message").textContent = data.alerts.length ? data.alerts.length + " waiting." : "No pickup alerts.";
    const list = byId("history");
    list.replaceChildren();
    for (const entry of data.history) {
        const item = document.createElement("li");
        item.textContent = new Date(entry.time).toLocaleString() + " · " + entry.action +
            " · " + entry.taken + " seats taken · session " + entry.session;
        list.append(item);
    }
}

async function unlock(takeover) {
    if (busy || !code.reportValidity()) return;
    if (takeover && !confirm("Take control of this shuttle? The other device will lose access.")) return;
    busy = true;
    pendingRefresh?.abort();
    updateControls();
    try {
        const { token } = await request("/driver/session", "POST", { code: code.value, takeover }, driverShuttle.value);
        sessions[driverShuttle.value] = token;
        saveStorage("malay-shuttle-driver-sessions", sessions);
        code.value = "";
        byId("driver-message").textContent = "Shuttle unlocked for this device.";
    } catch (error) {
        byId("driver-message").textContent = error.message;
    } finally {
        busy = false;
        updateControls();
        refresh();
    }
}

byId("unlock-form").onsubmit = event => { event.preventDefault(); unlock(false); };
byId("takeover").onclick = () => unlock(true);
byId("release").onclick = async () => {
    if (busy) return;
    busy = true;
    pendingRefresh?.abort();
    updateControls();
    try {
        await request("/driver/session", "DELETE", undefined, driverShuttle.value);
        delete sessions[driverShuttle.value];
        saveStorage("malay-shuttle-driver-sessions", sessions);
        byId("driver-message").textContent = "Control released.";
        showAlerts([]);
        byId("history").replaceChildren();
    } catch (error) {
        byId("driver-message").textContent = error.message;
    } finally {
        busy = false;
        updateControls();
        refresh();
    }
};

async function driverAction(action, fields = {}) {
    if (busy || !driverStatus) return;
    const shuttleId = Number(driverShuttle.value);
    const intent = JSON.stringify({ shuttleId, action, ...fields });
    if (!pendingAction || pendingAction.intent !== intent) {
        pendingAction = { intent, body: { action, ...fields, operationId: crypto.randomUUID(),
            tripId: driverStatus.tripId, version: String(driverStatus.version) } };
        saveStorage("malay-shuttle-driver-operation", pendingAction);
    }
    busy = true;
    pendingRefresh?.abort();
    updateControls();
    try {
        const data = await request("/driver/action", "POST", pendingAction.body, shuttleId);
        pendingAction = null;
        saveStorage("malay-shuttle-driver-operation", null);
        showDashboard(data);
        byId("seat-input").value = data.status.taken;
        byId("driver-message").textContent = "Action saved.";
    } catch (error) {
        if (error.status && error.status < 500) {
            pendingAction = null;
            saveStorage("malay-shuttle-driver-operation", null);
        }
        byId("driver-message").textContent = error.message +
            (error.status ? "" : " If the result is uncertain, retry the same action.");
    } finally {
        busy = false;
        updateControls();
        refresh();
    }
}

byId("seat-form").onsubmit = event => {
    event.preventDefault();
    driverAction("set", { value: byId("seat-input").valueAsNumber });
};
byId("start-trip").onclick = () => {
    if (byId("seat-input").reportValidity()) driverAction("start", { value: byId("seat-input").valueAsNumber });
};
byId("seat-plus").onclick = () => driverAction("adjust", { value: 1 });
byId("seat-minus").onclick = () => driverAction("adjust", { value: -1 });
byId("end-trip").onclick = () => {
    if (confirm("End the selected trip? Seats will reset and waiting passengers will be notified.")) driverAction("end");
};

byId("ping-form").onsubmit = async event => {
    event.preventDefault();
    const button = byId("ping-button");
    button.disabled = true;
    const message = byId("ping-message");
    const shuttleId = passengerShuttle;
    const stop = selectedStop;
    try {
        if (receipts.filter(item => item.expiresAt > Date.now()).length >= 10) {
            throw new Error("This tab is already tracking ten requests. Wait for them to expire.");
        }
        const { receipt } = await request("/alerts", "POST", { name: byId("name").value.trim(), stop }, shuttleId);
        receipts.push({ receipt, expiresAt: Date.now() + 60 * 60000 });
        saveStorage("malay-shuttle-receipts", receipts);
        message.textContent = "Ping sent to Shuttle " + shuttleId + " for " + stop + ". Keep this tab open for replies.";
    } catch (error) {
        message.textContent = error.message;
    } finally {
        renderFleet();
    }
};

function showReplies() {
    const list = byId("pickup-replies");
    list.replaceChildren();
    for (const item of receipts.filter(item => item.message && item.expiresAt > Date.now())) {
        const notice = document.createElement("p");
        notice.textContent = item.message;
        list.append(notice);
    }
}

async function checkPickupReplies(signal) {
    receipts = receipts.filter(item => item.expiresAt > Date.now());
    showReplies();
    if (!receipts.length) return;
    try {
        const replies = await request("/pickup-replies", "POST",
            { receipts: receipts.map(item => item.receipt) }, undefined, signal);
        if (signal.aborted) return;
        for (const item of receipts) {
            if (Object.hasOwn(replies, item.receipt)) item.message = replies[item.receipt];
        }
        saveStorage("malay-shuttle-receipts", receipts);
        showReplies();
        byId("reply-connection").textContent = "";
    } catch {
        if (!signal.aborted) byId("reply-connection").textContent = "Passenger replies could not refresh. Retrying…";
    }
}

async function refresh() {
    clearTimeout(refreshTimer);
    pendingRefresh?.abort();
    if (document.hidden || busy) return;
    pendingRefresh = new AbortController();
    const { signal } = pendingRefresh;
    const replies = checkPickupReplies(signal);
    const id = Number(driverShuttle.value);
    const driverVisible = driver.open && !byId("driver-panel").hidden && sessions[id];
    try {
        if (driverVisible) {
            try {
                const data = await request("/dashboard", "GET", undefined, id, signal);
                if (!signal.aborted) showDashboard(data);
                byId("connection").textContent = "";
                return;
            } catch (error) {
                if (signal.aborted) return;
                if (error.status !== 403) throw error;
                delete sessions[id];
                saveStorage("malay-shuttle-driver-sessions", sessions);
                showAlerts([]);
                byId("history").replaceChildren();
                byId("driver-message").textContent = error.message;
            }
        }
        const entries = await request("/shuttles", "GET", undefined, undefined, signal);
        if (!signal.aborted) {
            showFleet(entries);
            byId("connection").textContent = "";
        }
    } catch (error) {
        if (!signal.aborted) byId("connection").textContent = "Could not refresh shuttle data. Displayed counts may be old.";
    } finally {
        await replies;
        if (!signal.aborted) refreshTimer = setTimeout(refresh, 30000);
    }
}

driver.ontoggle = refresh;
driverShuttle.onchange = () => {
    showAlerts([]);
    byId("history").replaceChildren();
    byId("seat-input").value = "";
    byId("driver-message").textContent = "";
    const selected = fleet.find(entry => entry.shuttle.id === Number(driverShuttle.value));
    if (selected) showStatus(selected.status);
    refresh();
};
document.addEventListener("visibilitychange", refresh);
showReplies();
updateControls();
refresh();
