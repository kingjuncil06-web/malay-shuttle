/* ==========================================================
   MALAY-SHUTTLE: student interface logic
   Uses the existing endpoints unchanged:
   GET /api/seats, POST /api/reserve, GET /api/bookings, POST /api/cancel
   ========================================================== */

const incomingTimes = [
    "6:10 AM", "7:20 AM", "8:45 AM",
    "10:00 AM", "11:20 AM", "12:20 PM",
    "1:45 PM"
];

const outgoingTimes = [
    "12:30 PM", "1:30 PM", "2:30 PM",
    "4:00 PM", "5:30 PM", "6:30 PM",
    "7:30 PM", "9:00 PM"
];

const pickupPoints = [
    "Pacita Astrodome",
    "Ukay-Ukay beside Savemore",
    "Uncle John's Maria Aurora",
    "Southwoods"
];

// Hypothetical travel times (not yet verified with the operator)
const stopOffsets = [0, 8, 15, 22]; // Southwoods: sample 22-minute offset

// Sample capacity. Must match CAPACITY in ReservationService.java.
const CAPACITY = 15;
const ALMOST_FULL_AT = 5;
const STORAGE_KEY = "malayShuttleStudentId";

/* ---------- Demo role selection (not server authentication) ---------- */
const DEMO_SESSION_KEY = "malayShuttleDemoSession";
let activeProfile = null;
function mayReserve() { return activeProfile && ["Student", "Staff"].includes(activeProfile.role); }
function currentId() { return mayReserve() ? activeProfile.id : ""; }
function updateAccountDisplay() {
    document.getElementById("currentProfile").textContent = `${activeProfile.name} · ${activeProfile.role} (demo)`;
    document.getElementById("bookingProfile").textContent = `${activeProfile.name} · ${activeProfile.id || "Browser"}`;
    document.getElementById("reservationProfile").textContent = `${activeProfile.name} · ${activeProfile.id}`;
    document.getElementById("searchStudentId").value = currentId();
    document.getElementById("studentName").value = activeProfile.name;
    document.getElementById("studentId").value = currentId();
    document.querySelectorAll('[data-view="bookings"]').forEach(b => b.hidden = !mayReserve());
}
function enterDemo(profile) {
    activeProfile = profile;
    sessionStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(profile));
    document.getElementById("loginScreen").hidden = true;
    document.getElementById("appShell").hidden = false;
    bookingsAutoLoaded = false;
    document.getElementById("bookingResults").replaceChildren();
    updateAccountDisplay();
    showView("home");
    renderTrips();
}
function switchDemo() {
    activeProfile = null;
    sessionStorage.removeItem(DEMO_SESSION_KEY);
    document.getElementById("appShell").hidden = true;
    document.getElementById("loginScreen").hidden = false;
    document.getElementById("loginForm").reset();
    document.getElementById("loginForm").dispatchEvent(new Event("change"));
}
document.getElementById("loginForm").addEventListener("change", () => {
    const guest = ["Guest"].includes(document.querySelector('input[name="accessRole"]:checked').value);
    const area = document.getElementById("loginIdentity");
    area.hidden = guest;
    area.querySelectorAll("input").forEach(input => input.required = !guest);
});
document.getElementById("loginForm").addEventListener("submit", event => {
    event.preventDefault();
    const role = document.querySelector('input[name="accessRole"]:checked').value;
    const guest = role === "Guest";
    const name = guest ? "Guest" : document.getElementById("loginName").value.trim();
    const id = guest ? "" : document.getElementById("loginId").value.trim();
    if (!guest && (!name || !id)) return;
    enterDemo({role, name, id});
});
["switchAccountSidebar", "switchAccountHeader"].forEach(id => document.getElementById(id).addEventListener("click", switchDemo));

/* ---------- Element references ---------- */
const directionSelect = document.getElementById("direction");
const pickupSelect = document.getElementById("pickup");
const pickupField = document.getElementById("pickupField");
const tripList = document.getElementById("tripList");
const tripCount = document.getElementById("tripCount");

const dialog = document.getElementById("reservationDialog");
const form = document.getElementById("reservationForm");
const message = document.getElementById("reservationMessage");

const confirmationDialog = document.getElementById("confirmationDialog");
const confirmDialog = document.getElementById("confirmDialog");
const toastEl = document.getElementById("toast");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let selectedDeparture = null;
let selectedPickupPoint = null;
let renderToken = 0;

/* ---------- Icons (Lucide-style, inlined so no extra download) ---------- */
const ICONS = {
    bus: '<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'
};

function iconEl(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "icon");
    svg.innerHTML = ICONS[name] || "";
    return svg;
}

function hydrateIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach(node => {
        node.replaceChildren(iconEl(node.dataset.icon));
    });
}

/* ---------- Small helpers ---------- */
function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function iconWrap(name) {
    const wrap = el("span", "ic");
    wrap.append(iconEl(name));
    return wrap;
}

function toMinutes(time) {
    const [clock, period] = time.split(" ");
    let [hours, minutes] = clock.split(":").map(Number);

    hours = hours % 12;
    if (period === "PM") hours += 12;

    return hours * 60 + minutes;
}

function formatMinutes(total) {
    total = ((total % 1440) + 1440) % 1440;

    let hours = Math.floor(total / 60);
    const minutes = total % 60;
    const period = hours >= 12 ? "PM" : "AM";

    hours = hours % 12 || 12;

    return `${hours}:${String(minutes).padStart(2, "0")} ${period}`;
}

function getSavedId() { return currentId(); }
function saveId(id) { /* Current identity comes from the active demo profile. */ }

function statusLabel(status) {
    if (status === "RESERVED") return "Reserved";
    if (status === "CANCELLED") return "Cancelled";
    return status;
}

function statusTone(status) {
    if (status === "RESERVED") return "tone-booked";
    if (status === "CANCELLED") return "tone-muted";
    return "tone-muted";
}

function setLoading(button, loading) {
    button.classList.toggle("is-loading", loading);
    button.disabled = loading;
}

let toastTimer = null;
function showToast(text, type = "info") {
    toastEl.textContent = text;
    toastEl.className = `toast is-${type}`;
    // force a reflow so the transition replays
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

/* ---------- Bottom sheets (native <dialog> with exit animation) ---------- */
function closeSheet(dlg) {
    return new Promise(resolve => {
        if (!dlg.open) {
            resolve();
            return;
        }

        if (reducedMotion.matches) {
            dlg.close();
            resolve();
            return;
        }

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            dlg.removeEventListener("animationend", onEnd);
            dlg.classList.remove("is-closing");
            dlg.close();
            resolve();
        };
        const onEnd = event => {
            if (event.target === dlg) finish();
        };

        dlg.addEventListener("animationend", onEnd);
        dlg.classList.add("is-closing");
        setTimeout(finish, 350); // safety net
    });
}

document.querySelectorAll("dialog.sheet").forEach(dlg => {
    // Escape key
    dlg.addEventListener("cancel", event => {
        event.preventDefault();
        closeSheet(dlg);
    });
    // Tap on the dark backdrop
    dlg.addEventListener("click", event => {
        if (event.target === dlg) closeSheet(dlg);
    });
});

/* ---------- Navigation between views ---------- */
const views = {
    home: document.getElementById("view-home"),
    bookings: document.getElementById("view-bookings"),
    schedule: document.getElementById("view-schedule"),
    feedback: document.getElementById("view-feedback")
};
const navItems = document.querySelectorAll(".nav-item");
let bookingsAutoLoaded = false;

function showView(name) {
    Object.entries(views).forEach(([key, section]) => {
        section.classList.toggle("is-active", key === name);
    });

    navItems.forEach(item => {
        const active = item.dataset.view === name;
        item.classList.toggle("is-active", active);
        if (active) {
            item.setAttribute("aria-current", "page");
        } else {
            item.removeAttribute("aria-current");
        }
    });

    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });


    if (name === "bookings" && mayReserve() && !bookingsAutoLoaded) {
        bookingsAutoLoaded = true;
        if (document.getElementById("searchStudentId").value.trim()) {
            loadBookings();
        }
    }
}

navItems.forEach(item => {
    item.addEventListener("click", () => {
        if (item.dataset.view === "profile") {
            showToast("Profile is coming soon.");
            return;
        }
        if (item.dataset.view === "bookings" && !mayReserve()) { showToast("Sign in as Student or Staff to view bookings."); return; }
        showView(item.dataset.view);
    });
});

/* ---------- API calls ---------- */
async function fetchSeats(time) {
    try {
        const params = new URLSearchParams({ departure: time });
        const response = await fetch(`/api/seats?${params}`);
        if (!response.ok) throw new Error("Failed to retrieve seats");
        const data = await response.json();
        const available = Number(data.available);
        return Number.isFinite(available) ? available : null;
    } catch (error) {
        return null;
    }
}

async function fetchBookings(studentId) {
    try {
        const params = new URLSearchParams({ studentId });
        const response = await fetch(`/api/bookings?${params}`);
        if (!response.ok) throw new Error("Cannot retrieve bookings");
        return await response.json();
    } catch (error) {
        return null;
    }
}

/* ---------- Trip cards ---------- */
function skeletonCard(index) {
    const card = el("div", "skeleton");
    card.style.setProperty("--i", index);
    card.append(
        el("div", "sk lg"),
        el("div", "sk md"),
        el("div", "sk"),
        el("div", "sk btn-sk")
    );
    return card;
}

function showSkeletons(count) {
    tripList.replaceChildren(
        ...Array.from({ length: count }, (_, i) => skeletonCard(i))
    );
}

function buildPips(taken, total) {
    const pips = el("div", "pips");
    for (let i = 0; i < total; i++) {
        const pip = el("span", i < taken ? "pip taken" : "pip");
        pip.style.setProperty("--p", i);
        pips.append(pip);
    }
    return pips;
}

function buildTripCard(time, index, opts) {
    const { incoming, pickupIndex, available, booking } = opts;

    const card = el("article", "trip-card");
    card.style.setProperty("--i", index);

    // Decide the card's state
    let tone = "tone-muted";
    let badgeText = "Unavailable";
    let buttonText = "Unavailable";
    let buttonEnabled = false;

    if (!incoming) {
        badgeText = "Coming soon";
        buttonText = "Outgoing booking coming soon";
    } else if (booking) {
        tone = "tone-booked";
        badgeText = "You're booked";
        buttonText = `Reserved, ref. #${booking.queueNumber}`;
    } else if (available === null) {
        badgeText = "No data";
        buttonText = "Availability unavailable";
    } else if (!mayReserve()) {
        badgeText = "View only";
        buttonText = "Sign in as Student or Staff to book";
    } else if (available <= 0) {
        tone = "tone-full";
        badgeText = "Fully booked";
        buttonText = "Fully booked";
    } else if (available <= ALMOST_FULL_AT) {
        tone = "tone-low";
        badgeText = "Almost full";
        buttonText = "Reserve seat";
        buttonEnabled = true;
    } else {
        tone = "tone-ok";
        badgeText = "Seats available";
        buttonText = "Reserve seat";
        buttonEnabled = true;
    }

    card.classList.add(tone);

    // Top row: departure time and status badge
    const top = el("div", "trip-top");
    top.append(el("h3", "trip-time", time), el("span", "badge", badgeText));
    card.append(top);

    // Pickup / ETA
    const eta = el("div", "meta-row");
    eta.append(iconWrap("pin"));
    const etaText = el("div");
    if (incoming) {
        const pickupName = booking ? booking.pickupPoint : pickupPoints[pickupIndex];
        etaText.append(
            el("span", "", pickupName),
            el(
                "small",
                "",
                stopOffsets[pickupIndex] === null
                    ? "Pickup ETA pending route confirmation"
                    : `Estimated pickup ${formatMinutes(toMinutes(time) + stopOffsets[pickupIndex])} (sample estimate)`
            )
        );
    } else {
        etaText.append(el("span", "", "Pickup ETA not configured"));
    }
    eta.append(etaText);
    card.append(eta);

    // Seat availability (real number from /api/seats)
    if (incoming && available !== null) {
        const safe = Math.max(0, Math.min(CAPACITY, available));
        const taken = CAPACITY - safe;

        const seats = el("div", "seat-block");
        const text = el("div", "seat-text");
        const left = el("strong", "", `${available} ${available === 1 ? "seat" : "seats"} left`);
        text.append(left, el("span", "", `of ${CAPACITY}`));

        const pips = buildPips(taken, CAPACITY);
        pips.setAttribute("role", "img");
        pips.setAttribute("aria-label", `${taken} of ${CAPACITY} seats taken`);

        seats.append(text, pips);
        card.append(seats);
    } else if (incoming) {
        const seats = el("div", "seat-block");
        const text = el("div", "seat-text");
        text.append(el("strong", "", "Availability unavailable"));
        seats.append(text);
        card.append(seats);
    }

    // Action button
    const button = el("button", "btn btn-primary");
    button.type = "button";
    button.disabled = !buttonEnabled;
    if (booking) button.classList.add("is-booked");
    if (booking) button.append(iconWrap("check"));
    button.append(el("span", "btn-label", buttonText));

    if (buttonEnabled) {
        button.addEventListener("click", () => openReservation(time));
    }

    card.append(button);
    return card;
}

async function renderTrips() {
    const token = ++renderToken;

    const incoming = directionSelect.value === "incoming";
    const schedules = incoming ? incomingTimes : outgoingTimes;
    const pickupIndex = Number(pickupSelect.value);

    pickupSelect.disabled = !incoming;
    pickupField.classList.toggle("is-disabled", !incoming);
    tripCount.textContent = `${schedules.length} trips`;

    if (!incoming) {
        tripList.replaceChildren(
            ...schedules.map((time, i) =>
                buildTripCard(time, i, { incoming: false, pickupIndex })
            )
        );
        return;
    }

    showSkeletons(schedules.length);

    const savedId = getSavedId();

    const [seatResults, bookings] = await Promise.all([
        Promise.all(schedules.map(fetchSeats)),
        savedId ? fetchBookings(savedId) : Promise.resolve(null)
    ]);

    // A newer render started while we were waiting; drop this one.
    if (token !== renderToken) return;

    const bookedByTrip = new Map();
    (bookings || [])
        .filter(b => b.status === "RESERVED")
        .forEach(b => bookedByTrip.set(b.departure, b));

    tripList.replaceChildren(
        ...schedules.map((time, i) =>
            buildTripCard(time, i, {
                incoming: true,
                pickupIndex,
                available: seatResults[i],
                booking: bookedByTrip.get(time)
            })
        )
    );
}

/* ---------- Reservation sheet ---------- */
function openReservation(departure) {
    if (!mayReserve()) { showToast("Only Student or Staff demo profiles can reserve."); return; }
    selectedDeparture = departure;
    selectedPickupPoint = pickupPoints[Number(pickupSelect.value)];

    form.reset();
    message.textContent = "";
    message.classList.remove("is-info");

    document.getElementById("selectedTrip").textContent =
        `Departure: ${departure}`;

    document.getElementById("selectedPickup").textContent =
        `Pickup: ${selectedPickupPoint}`;

    document.getElementById("studentName").value = activeProfile.name;
    document.getElementById("studentId").value = activeProfile.id;

    dialog.showModal();
}

document.getElementById("closeDialog").addEventListener("click", () => {
    closeSheet(dialog);
});

form.addEventListener("submit", async event => {
    event.preventDefault();

    const button = document.getElementById("confirmReservation");
    setLoading(button, true);
    message.classList.add("is-info");
    message.textContent = "Reserving your seat...";

    if (!mayReserve()) { setLoading(button, false); return; }
    const name = activeProfile.name;
    const id = activeProfile.id;

    const params = new URLSearchParams({
        departure: selectedDeparture,
        studentName: name,
        studentId: id,
        pickupPoint: selectedPickupPoint
    });

    try {
        const response = await fetch("/api/reserve", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params.toString()
        });

        if (!response.ok) {
            message.classList.remove("is-info");
            message.textContent = response.status === 409
                ? "Already booked, or this shuttle is fully booked."
                : "Reservation failed. Please try again.";
            return;
        }

        const booking = await response.json();

        saveId(id);
        document.getElementById("searchStudentId").value = id;

        await closeSheet(dialog);
        showConfirmation(booking);

        // Refresh the data behind the sheet
        renderTrips();
        loadBookings();

    } catch (error) {
        message.classList.remove("is-info");
        message.textContent = "Cannot connect to the server. Check your connection and try again.";
    } finally {
        setLoading(button, false);
    }
});

/* ---------- Booking confirmation ---------- */
function showConfirmation(booking) {
    document.getElementById("doneQueue").textContent = `#${booking.queueNumber}`;

    const rows = [
        ["Departure", booking.departure],
        ["Pickup", booking.pickupPoint],
        ["Status", statusLabel(booking.status)],
        ["Booking ID", booking.bookingId, "mono"]
    ];
    if (booking.serviceDate) {
        rows.splice(1, 0, ["Date", String(booking.serviceDate)]);
    }

    const list = document.getElementById("doneDetails");
    list.replaceChildren(
        ...rows.map(([label, value, cls]) => {
            const row = el("div");
            row.append(el("dt", "", label), el("dd", cls || "", String(value)));
            return row;
        })
    );

    confirmationDialog.showModal();

    // Replay the checkmark animation each time
    const mark = document.getElementById("successMark");
    mark.classList.remove("play");
    void mark.offsetWidth;
    mark.classList.add("play");
}

document.getElementById("doneClose").addEventListener("click", () => {
    closeSheet(confirmationDialog);
});

document.getElementById("doneViewBooking").addEventListener("click", async () => {
    await closeSheet(confirmationDialog);
    bookingsAutoLoaded = true;
    showView("bookings");
});

/* ---------- In-app confirm (replaces window.confirm) ---------- */
let confirmResult = false;

function askConfirm({ title, text, yes, no }) {
    return new Promise(resolve => {
        confirmResult = false;
        document.getElementById("confirmTitle").textContent = title;
        document.getElementById("confirmText").textContent = text;
        document.querySelector("#confirmYes .btn-label").textContent = yes;
        document.querySelector("#confirmNo .btn-label").textContent = no;

        confirmDialog.addEventListener("close", () => resolve(confirmResult), { once: true });
        confirmDialog.showModal();
    });
}

document.getElementById("confirmYes").addEventListener("click", () => {
    confirmResult = true;
    closeSheet(confirmDialog);
});

document.getElementById("confirmNo").addEventListener("click", () => {
    confirmResult = false;
    closeSheet(confirmDialog);
});

/* ---------- My Booking ---------- */
function emptyState(iconName, title, text, isError = false) {
    const box = el("div", isError ? "empty is-error" : "empty");
    box.append(iconWrap(iconName), el("strong", "", title), el("p", "", text));
    return box;
}

function showBookingSkeletons() {
    const results = document.getElementById("bookingResults");
    results.replaceChildren(skeletonCard(0), skeletonCard(1));
}

/* Demo-only assignments: consistent by departure, not stored in MySQL. */
const DEMO_SHUTTLES = [
    { shuttle: "Shuttle 1", driver: "Sample Driver A", plate: "DEMO-001" },
    { shuttle: "Shuttle 2", driver: "Sample Driver B", plate: "DEMO-002" },
    { shuttle: "Shuttle 3", driver: "Sample Driver C", plate: "DEMO-003" }
];

function demoAssignment(booking) {
    const index = incomingTimes.indexOf(booking.departure);
    return DEMO_SHUTTLES[(index >= 0 ? index : 0) % DEMO_SHUTTLES.length];
}

function buildAssignedShuttle(booking) {
    const driver = demoAssignment(booking);
    const section = el("section", "assigned-shuttle");
    section.setAttribute("aria-label", "Sample assigned shuttle details");
    const title = el("div", "assigned-shuttle-top");
    title.append(el("strong", "", "Your shuttle — demo assignment"), el("span", "sample-chip", "SAMPLE ONLY"));
    const rows = el("dl", "assigned-shuttle-details");
    for (const [label, value] of [
        ["Shuttle", driver.shuttle],
        ["Driver", driver.driver],
        ["Vehicle identifier", driver.plate]
    ]) {
        const row = el("div", "assigned-shuttle-row");
        row.append(el("dt", "", label), el("dd", "", value));
        rows.append(row);
    }
    section.append(title, rows,
        el("p", "assigned-shuttle-note", "Illustrative information only. The actual shuttle and driver have not been assigned or verified. Do not use these details to identify a vehicle."));
    return section;
}

function buildBookingCard(booking, studentId, index) {
    const cancelled = booking.status === "CANCELLED";

    const card = el("article", cancelled ? "booking-card is-cancelled" : "booking-card");
    card.style.setProperty("--i", index);

    const queue = el("div", "queue-badge");
    queue.append(el("span", "", "Reservation ref."), el("strong", "", `#${booking.queueNumber}`));

    const info = el("div", "booking-info");

    const timeRow = el("div", "meta-row");
    timeRow.append(iconWrap("clock"), el("span", "", booking.departure));

    const pinRow = el("div", "meta-row");
    pinRow.append(iconWrap("pin"), el("span", "", booking.pickupPoint));

    const badge = el("span", `badge ${statusTone(booking.status)}`, statusLabel(booking.status));

    info.append(timeRow, pinRow, badge);
    card.append(queue, info);
    if (!cancelled) card.append(buildAssignedShuttle(booking));

    if (booking.status === "RESERVED") {
        const cancel = el("button", "btn btn-danger");
        cancel.type = "button";
        cancel.append(el("span", "btn-label", "Cancel reservation"));

        cancel.addEventListener("click", async () => {
            const ok = await askConfirm({
                title: "Cancel this reservation?",
                text: `${booking.departure} at ${booking.pickupPoint}. Your seat will be released.`,
                yes: "Yes, cancel it",
                no: "Keep my seat"
            });
            if (!ok) return;

            setLoading(cancel, true);

            try {
                const body = new URLSearchParams({
                    bookingId: booking.bookingId,
                    studentId: studentId
                });

                const response = await fetch("/api/cancel", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                    body: body.toString()
                });

                if (!response.ok) throw new Error("Cancel failed");

                showToast("Reservation cancelled.", "success");
                await Promise.all([loadBookings(), renderTrips()]);
            } catch (error) {
                setLoading(cancel, false);
                showToast("Unable to cancel the reservation. Try again.", "error");
            }
        });

        card.append(cancel);
    }

    return card;
}

async function loadBookings() {
    const input = document.getElementById("searchStudentId");
    const id = currentId();
    const results = document.getElementById("bookingResults");
    const findButton = document.getElementById("findBookings");

    if (!id) {
        results.replaceChildren(
            emptyState("search", "Enter your student ID", "Type your ID above to see today's reservations.")
        );
        return;
    }

    setLoading(findButton, true);
    showBookingSkeletons();

    try {
        const params = new URLSearchParams({ studentId: id });
        const response = await fetch(`/api/bookings?${params}`);

        if (!response.ok) throw new Error("Cannot retrieve bookings");

        const bookings = await response.json();
        saveId(id);

        if (bookings.length === 0) {
            results.replaceChildren(
                emptyState("inbox", "No reservations today", "Reserve a seat from the Home tab and it will show up here.")
            );
            return;
        }

        results.replaceChildren(
            ...bookings.map((booking, i) => buildBookingCard(booking, id, i))
        );

    } catch (error) {
        results.replaceChildren(
            emptyState("alert", "Couldn't load reservations", "Check your connection and try again.", true)
        );
    } finally {
        setLoading(findButton, false);
    }
}

document.getElementById("findBookings").addEventListener("click", loadBookings);

document.getElementById("searchStudentId").addEventListener("keydown", event => {
    if (event.key === "Enter") {
        event.preventDefault();
        loadBookings();
    }
});


/* ---------- Reference-inspired timetable and real summary ---------- */
function renderScheduleTables() {
    const groups = [
        ["incomingSchedule", incomingTimes, "To campus"],
        ["outgoingSchedule", outgoingTimes, "From campus"]
    ];
    for (const [id, times, description] of groups) {
        const target = document.getElementById(id);
        if (!target) continue;
        target.replaceChildren(...times.map((time, i) => {
            const row = el("div", "schedule-row");
            const index = el("span", "schedule-index", String(i + 1).padStart(2, "0"));
            const detail = el("div", "schedule-detail");
            detail.append(el("strong", "", time), el("small", "", description));
            row.append(index, detail);
            if (id === "outgoingSchedule" && time === "9:00 PM") {
                row.append(el("span", "schedule-note", "If necessary"));
            }
            return row;
        }));
    }
}

function setSummarySchedule() {
    const localParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila", hour: "numeric", minute: "numeric", hour12: false
    }).formatToParts(new Date());
    const hh = Number(localParts.find(p => p.type === "hour")?.value || 0);
    const mm = Number(localParts.find(p => p.type === "minute")?.value || 0);
    const next = incomingTimes.find(t => toMinutes(t) > hh * 60 + mm);
    document.getElementById("nextDepartureLabel").textContent = next || "Finished";
}

async function refreshSummarySeats() {
    const label = document.getElementById("openTripsLabel");
    const subtitle = document.getElementById("openTripsSub");
    const result = await Promise.all(incomingTimes.map(fetchSeats));
    const valid = result.filter(n => n !== null);
    if (!valid.length) {
        label.textContent = "—";
        subtitle.textContent = "Server unavailable";
        return;
    }
    label.textContent = `${valid.filter(n => n > 0).length} / ${incomingTimes.length}`;
    subtitle.textContent = "Trips with seats left";
}

renderScheduleTables();
setSummarySchedule();
refreshSummarySeats();
document.querySelectorAll('[data-view="home"]').forEach(button => {
    button.addEventListener("click", () => { setSummarySchedule(); refreshSummarySeats(); });
});

/* ---------- Start up ---------- */
directionSelect.addEventListener("change", renderTrips);
pickupSelect.addEventListener("change", renderTrips);

hydrateIcons();
document.getElementById("searchStudentId").value = getSavedId();
renderTrips();

/* ---------- Rider feedback (saved by Spring Boot API) ---------- */
const feedbackForm = document.getElementById("feedbackForm");
feedbackForm.addEventListener("submit", async event => {
    event.preventDefault();
    const button = document.getElementById("submitFeedback");
    const status = document.getElementById("feedbackMessage");
    const rating = feedbackForm.querySelector('input[name="rating"]:checked');
    if (!rating) { status.textContent = "Please select a rating."; return; }
    const comment = document.getElementById("feedbackComment").value.trim();
    setLoading(button, true);
    status.textContent = "Submitting your feedback…";
    try {
        const response = await fetch("/api/feedback", {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: new URLSearchParams({rating: rating.value, comment}).toString()
        });
        if (!response.ok) throw new Error("Could not submit feedback");
        feedbackForm.reset();
        status.textContent = "Thank you! Your feedback has been saved.";
        showToast("Feedback submitted successfully.", "success");
    } catch (error) {
        status.textContent = "Unable to save feedback. Please try again.";
    } finally {
        setLoading(button, false);
    }
});

/* Initialize demo session after all application listeners are installed. */
try {
    const restored = JSON.parse(sessionStorage.getItem(DEMO_SESSION_KEY) || "null");
    if (restored && ["Student","Staff","Driver","Guest"].includes(restored.role)
        && typeof restored.name === "string" && typeof restored.id === "string") enterDemo(restored);
} catch (err) { sessionStorage.removeItem(DEMO_SESSION_KEY); }
