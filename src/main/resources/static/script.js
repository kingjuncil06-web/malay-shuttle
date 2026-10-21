
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
    "Uncle John's Maria Aurora"
];

// Hypothetical travel times
const stopOffsets = [0, 8, 15];

const directionSelect = document.getElementById("direction");
const pickupSelect = document.getElementById("pickup");
const tripList = document.getElementById("tripList");

const dialog = document.getElementById("reservationDialog");
const form = document.getElementById("reservationForm");
const message = document.getElementById("reservationMessage");

let selectedDeparture = null;
let selectedPickupPoint = null;

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

async function renderTrips() {
    const incoming = directionSelect.value === "incoming";
    const schedules = incoming ? incomingTimes : outgoingTimes;

    pickupSelect.disabled = !incoming;
    const pickupIndex = Number(pickupSelect.value);

    tripList.replaceChildren();

    for (const time of schedules) {
        const card = document.createElement("article");
        card.className = "shuttle-card";

        const title = document.createElement("h3");
        title.textContent = `Departure: ${time}`;

        const eta = document.createElement("p");
        eta.className = "eta";
        eta.textContent = incoming
            ? `Estimated pickup: ${formatMinutes(
                toMinutes(time) + stopOffsets[pickupIndex]
            )} (sample)`
            : "Pickup ETA not configured";

        const seats = document.createElement("p");
        seats.className = "seats";
        seats.textContent = "Checking availability...";

        const button = document.createElement("button");
        button.textContent = "Reserve Seat";
        button.disabled = true;

        card.append(title, eta, seats, button);
        tripList.appendChild(card);

        if (!incoming) {
            seats.textContent = "Outgoing booking coming soon";
            button.textContent = "Unavailable";
            continue;
        }

        button.onclick = () => openReservation(time);

        try {
            const params = new URLSearchParams({
                departure: time
            });

            const response = await fetch(`/api/seats?${params}`);

            if (!response.ok) {
                throw new Error("Failed to retrieve seats");
            }

            const data = await response.json();
            seats.textContent = `${data.available} seats available`;

            button.disabled = data.available <= 0;
            button.textContent =
                data.available <= 0 ? "Fully Booked" : "Reserve Seat";

        } catch (error) {
            seats.textContent = "Availability unavailable";
            button.disabled = true;
        }
    }
}

function openReservation(departure) {
    selectedDeparture = departure;
    selectedPickupPoint = pickupPoints[Number(pickupSelect.value)];

    form.reset();
    message.textContent = "";

    document.getElementById("selectedTrip").textContent =
        `Departure: ${departure}`;

    document.getElementById("selectedPickup").textContent =
        `Pickup: ${selectedPickupPoint}`;

    dialog.showModal();
}

document.getElementById("closeDialog").onclick = () => {
    dialog.close();
};

form.addEventListener("submit", async event => {
    event.preventDefault();

    const button = document.getElementById("confirmReservation");
    button.disabled = true;
    message.textContent = "Processing reservation...";

    const name = document.getElementById("studentName").value.trim();
    const id = document.getElementById("studentId").value.trim();

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
            message.textContent = response.status === 409
                ? "Already booked or shuttle fully booked."
                : "Reservation failed. Try again.";
            return;
        }

        const booking = await response.json();

        dialog.close();

        alert(
            "Reservation Successful!\n\n" +
            `Queue Number: ${booking.queueNumber}\n` +
            `Booking ID: ${booking.bookingId}\n` +
            `Departure: ${booking.departure}\n` +
            `Pickup: ${booking.pickupPoint}`
        );

        document.getElementById("searchStudentId").value = id;
        await renderTrips();
        await loadBookings();

    } catch (error) {
        message.textContent = "Cannot connect to server.";
    } finally {
        button.disabled = false;
    }
});

async function loadBookings() {
    const id = document.getElementById("searchStudentId").value.trim();
    const results = document.getElementById("bookingResults");

    results.replaceChildren();

    if (!id) {
        results.textContent = "Please enter your student ID.";
        return;
    }

    try {
        const params = new URLSearchParams({studentId: id});
        const response = await fetch(`/api/bookings?${params}`);

        if (!response.ok) throw new Error("Cannot retrieve bookings");

        const bookings = await response.json();

        if (bookings.length === 0) {
            results.textContent = "No reservations found today.";
            return;
        }

        bookings.forEach(booking => {
            const card = document.createElement("div");
            card.className = "shuttle-card";

            const heading = document.createElement("h3");
            heading.textContent = `Queue #${booking.queueNumber}`;

            const details = document.createElement("p");
            details.textContent =
                `${booking.departure} — ${booking.pickupPoint}`;

            const status = document.createElement("p");
            status.textContent = `Status: ${booking.status}`;

            card.append(heading, details, status);

            if (booking.status === "RESERVED") {
                const cancel = document.createElement("button");
                cancel.className = "secondary-button";
                cancel.textContent = "Cancel Reservation";

                cancel.onclick = async () => {
                    if (!confirm("Cancel this reservation?")) return;

                    const body = new URLSearchParams({
                        bookingId: booking.bookingId,
                        studentId: id
                    });

                    const response = await fetch("/api/cancel", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                        body: body.toString()
                    });

                    if (!response.ok) {
                        alert("Unable to cancel reservation.");
                        return;
                    }

                    await loadBookings();
                    await renderTrips();
                };

                card.appendChild(cancel);
            }

            results.appendChild(card);
        });

    } catch (error) {
        results.textContent = "Unable to load reservations.";
    }
}

document.getElementById("findBookings")
    .addEventListener("click", loadBookings);

directionSelect.addEventListener("change", renderTrips);
pickupSelect.addEventListener("change", renderTrips);

renderTrips();
