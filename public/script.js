const byId = id => document.getElementById(id);
const driver = byId("driver");
const code = byId("code");
let selectedStop;
let alertSignature;
const receiptStorage = "malay-shuttle-receipts";
let receipts = [];
try {
    receipts = JSON.parse(sessionStorage.getItem(receiptStorage) || "[]");
} catch {
    // The current page can still receive replies when browser storage is unavailable.
}

function saveReceipts() {
    try {
        sessionStorage.setItem(receiptStorage, JSON.stringify(receipts));
    } catch {
        // Keep receipts in memory for this page.
    }
}

async function request(path, method = "GET", body, driverCode, signal) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (driverCode) headers["X-Driver-Code"] = driverCode;
    const response = await fetch("/api" + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal
    });
    if (!response.ok) {
        const messages = { 400: "Check the values you entered.", 403: "Check the driver code.",
            404: "This ping is no longer available.",
            409: "A ping for this name and pickup point is already pending.",
            429: "The alert list is full. Try again later." };
        const error = new Error(messages[response.status] || "The server could not complete the request.");
        error.status = response.status;
        throw error;
    }
    if (response.status !== 204) return response.json();
}

function switchTab(button, buttons) {
    for (const tab of buttons) tab.setAttribute("aria-pressed", String(tab === button));
}

const views = document.querySelectorAll("[data-view]");
for (const button of views) {
    button.onclick = () => {
        switchTab(button, views);
        for (const tab of views) byId(tab.dataset.view).hidden = tab !== button;
        refresh();
    };
}

function showStatus({ taken, available, stops, updatedAt }) {
    byId("taken").textContent = taken;
    byId("available").textContent = available;
    byId("seat-input").max = taken + available;
    byId("seat-updated").textContent = "Seat count last updated: " +
        (updatedAt ? new Date(updatedAt).toLocaleString() : "—");
    byId("connection").textContent = "";
    const stopTabs = byId("stops");
    if (stopTabs.childElementCount) return;
    for (const stop of stops) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = stop;
        button.setAttribute("aria-pressed", "false");
        button.onclick = () => {
            switchTab(button, stopTabs.children);
            selectedStop = stop;
            byId("ping-button").disabled = false;
            byId("ping-message").textContent = "";
        };
        stopTabs.append(button);
    }
}

function showAlerts(alerts) {
    const signature = JSON.stringify(alerts);
    if (signature === alertSignature) return;
    alertSignature = signature;
    byId("alert-count").textContent = alerts.length ? "(" + alerts.length + ")" : "";
    const list = byId("alerts");
    list.replaceChildren();
    for (const alert of alerts) {
        const item = document.createElement("li");
        item.textContent = alert.name + " is waiting at " + alert.stop + ".";
        const actions = [["Pick up", "", "DELETE"]];
        if (alert.canReply) actions.push(["Can’t pick up", "/decline", "POST"]);
        for (const [label, suffix, method] of actions) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.onclick = async () => {
                const buttons = item.querySelectorAll("button");
                for (const action of buttons) action.disabled = true;
                try {
                    await request("/alerts/" + alert.id + suffix, method, undefined, code.value);
                    if (suffix) byId("driver-message").textContent = "Passenger notified.";
                    refresh();
                } catch (error) {
                    byId("alert-message").textContent = error.message;
                } finally {
                    for (const action of buttons) action.disabled = false;
                }
            };
            item.append(button);
        }
        list.append(item);
    }
}

function handleForm(formId, messageId, submit) {
    const form = byId(formId);
    const button = form.querySelector("button");
    form.onsubmit = async event => {
        event.preventDefault();
        button.disabled = true;
        const message = byId(messageId);
        message.textContent = "";
        try {
            message.textContent = await submit();
        } catch (error) {
            message.textContent = error.message;
        } finally {
            button.disabled = false;
        }
    };
}

const endTrip = byId("end-trip");
const updateSeats = byId("seat-form").querySelector("button");
handleForm("seat-form", "driver-message", async () => {
    endTrip.disabled = true;
    try {
        const status = await request("/status", "PUT", { taken: byId("seat-input").valueAsNumber }, code.value);
        showStatus(status);
        refresh();
        return "Seat count updated.";
    } finally {
        endTrip.disabled = false;
    }
});

handleForm("ping-form", "ping-message", async () => {
    const stop = selectedStop;
    const { receipt } = await request("/alerts", "POST", { name: byId("name").value.trim(), stop });
    receipts = [...receipts, { receipt, expiresAt: Date.now() + 60 * 60000 }].slice(-10);
    saveReceipts();
    return "Ping sent for " + stop + ". Keep this tab open for a reply.";
});

async function checkPickupReplies(signal) {
    const active = receipts.filter(({ expiresAt }) => expiresAt > Date.now());
    if (active.length !== receipts.length) {
        receipts = active;
        saveReceipts();
    }
    if (!active.length) return;
    try {
        const replies = await request("/pickup-replies", "POST",
            { receipts: active.map(({ receipt }) => receipt) }, undefined, signal);
        if (signal.aborted) return;
        for (const stop of Object.values(replies)) {
            const notice = document.createElement("p");
            notice.textContent = "The driver can’t pick you up at " + stop + ".";
            byId("pickup-replies").append(notice);
        }
        if (Object.keys(replies).length) {
            receipts = receipts.filter(({ receipt }) => !Object.hasOwn(replies, receipt));
            saveReceipts();
        }
    } catch {
        // Retry on the next refresh, independently of seat updates.
    }
}

let refreshTimer;
let pendingRefresh;

async function refresh() {
    clearTimeout(refreshTimer);
    pendingRefresh?.abort();
    if (document.hidden) return;
    pendingRefresh = new AbortController();
    const { signal } = pendingRefresh;
    const pickupReplies = checkPickupReplies(signal);
    const enteredCode = driver.open && !byId("status").hidden ? code.value : "";
    const message = byId("alert-message");
    if (!enteredCode) {
        showAlerts([]);
        message.textContent = "Enter the driver code to see waiting passengers.";
    }
    try {
        if (enteredCode) {
            try {
                const { status, alerts } = await request("/dashboard", "GET", undefined, enteredCode, signal);
                if (signal.aborted || code.value !== enteredCode) return;
                showStatus(status);
                showAlerts(alerts);
                message.textContent = alerts.length ? alerts.length + " waiting." : "No pickup alerts.";
                return;
            } catch (error) {
                if (signal.aborted || code.value !== enteredCode) return;
                showAlerts([]);
                message.textContent = error.message;
                if (error.status !== 403) throw error;
            }
        }
        const status = await request("/status", "GET", undefined, undefined, signal);
        if (!signal.aborted) showStatus(status);
    } catch {
        if (!signal.aborted) byId("connection").textContent = "Could not refresh seat counts. Retrying…";
    } finally {
        await pickupReplies;
        if (!signal.aborted) refreshTimer = setTimeout(refresh, 30000);
    }
}

code.oninput = () => showAlerts([]);
code.onchange = refresh;
driver.ontoggle = refresh;

endTrip.onclick = async () => {
    if (!code.reportValidity() || !confirm("End this trip? This resets occupied seats and clears all pickup pings.")) return;
    endTrip.disabled = true;
    updateSeats.disabled = true;
    const message = byId("driver-message");
    try {
        showStatus(await request("/trip/end", "POST", undefined, code.value));
        byId("seat-input").value = "";
        showAlerts([]);
        message.textContent = "Trip ended. Seats and pickup pings reset.";
        refresh();
    } catch (error) {
        message.textContent = error.message;
    } finally {
        endTrip.disabled = false;
        updateSeats.disabled = false;
    }
};

document.addEventListener("visibilitychange", refresh);
refresh();
