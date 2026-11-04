const byId = id => document.getElementById(id);
const driver = byId("driver");
const code = byId("code");
let selectedStop;
let alertSignature;

async function request(path, method = "GET", body, driverCode) {
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (driverCode) headers["X-Driver-Code"] = driverCode;
    const response = await fetch("/api" + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store"
    });
    if (!response.ok) {
        const messages = { 400: "Check the values you entered.", 403: "Check the driver code.",
            429: "The alert list is full. Try again later." };
        throw new Error(messages[response.status] || "The server could not complete the request.");
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

function showStatus({ taken, available, stops }) {
    byId("taken").textContent = taken;
    byId("available").textContent = available;
    byId("seat-input").max = taken + available;
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
                await refreshAlerts();
            } catch (error) {
                byId("alert-message").textContent = error.message;
            }
        };
        item.append(button);
        list.append(item);
    }
}

async function refreshAlerts() {
    const enteredCode = code.value;
    const message = byId("alert-message");
    if (document.hidden || byId("status").hidden) return;
    if (!driver.open || !enteredCode) {
        showAlerts([]);
        message.textContent = "Enter the driver code to see waiting passengers.";
        return;
    }
    try {
        const alerts = await request("/alerts", "GET", undefined, enteredCode);
        if (code.value !== enteredCode || !driver.open) return;
        showAlerts(alerts);
        message.textContent = alerts.length ? alerts.length + " waiting." : "No pickup alerts.";
    } catch (error) {
        if (code.value !== enteredCode || !driver.open) return;
        showAlerts([]);
        message.textContent = error.message;
    }
}

code.oninput = () => showAlerts([]);
code.onchange = refreshAlerts;
driver.ontoggle = refreshAlerts;

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

handleForm("seat-form", "driver-message", async () => {
    const status = await request("/status", "PUT", { taken: byId("seat-input").valueAsNumber }, code.value);
    showStatus(status);
    return "Seat count updated.";
});

handleForm("ping-form", "ping-message", async () => {
    const stop = selectedStop;
    await request("/alerts", "POST", { name: byId("name").value.trim(), stop });
    return "Ping sent for " + stop + ".";
});

let refreshTimer;
let refreshing = false;

async function refresh() {
    clearTimeout(refreshTimer);
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
        showStatus(await request("/status"));
    } catch {
        byId("connection").textContent = "Could not refresh seat counts. Retrying…";
    }
    await refreshAlerts();
    refreshing = false;
    if (!document.hidden) refreshTimer = setTimeout(refresh, 30000);
}

document.addEventListener("visibilitychange", refresh);
refresh();
