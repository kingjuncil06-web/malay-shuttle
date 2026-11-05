const byId = id => document.getElementById(id);
const driver = byId("driver");
const code = byId("code");
let selectedStop;
let alertSignature;

async function request(path, method = "GET", body, driverCode, signal) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (driverCode) headers["X-Driver-Code"] = driverCode;
    const response = await fetch("/api" + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal
    });
    if (!response.ok) {
        const messages = { 400: "Check the values you entered.", 403: "Check the driver code.",
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
        const button = document.createElement("button");
        button.textContent = "Dismiss";
        button.onclick = async () => {
            try {
                await request("/alerts/" + alert.id, "DELETE", undefined, code.value);
                refresh();
            } catch (error) {
                byId("alert-message").textContent = error.message;
            }
        };
        item.append(button);
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
    await request("/alerts", "POST", { name: byId("name").value.trim(), stop });
    return "Ping sent for " + stop + ".";
});

let refreshTimer;
let pendingRefresh;

async function refresh() {
    clearTimeout(refreshTimer);
    pendingRefresh?.abort();
    if (document.hidden) return;
    pendingRefresh = new AbortController();
    const { signal } = pendingRefresh;
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
