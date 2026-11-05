# MALAY-SHUTTLE source guide

MALAY-SHUTTLE displays independent seat counts for three 15-seat shuttles on the same four-stop route. The Passenger panel shows all three with sample plates DEMO-001, DEMO-002, and DEMO-003. Passengers choose a shuttle before pinging its driver. The Driver panel manages the selected shuttle’s seats and alerts.

## How the app works

1. **Check seats.** The browser asks the server for the current count. If 9 of 15 seats are taken, the server sends back 9 taken and 6 available. The browser refreshes about every 30 seconds while its tab is visible and checks again when you return to the tab.
2. **Update seats.** The driver unlocks the selected shuttle with its own code and starts a trip with a confirmed occupied count. The server accepts counts from 0 to 15, binds updates to the current trip, and rejects stale state versions. One session controls each shuttle for up to eight hours. Explicit takeover invalidates the previous session.
3. **Send a pickup alert.** The passenger opens **Pickup ping**, selects a location tab, enters their name, and presses **I’m still at the pickup point**. The location comes from the selected tab. The browser does not ask for GPS access.
4. **Handle an alert.** Requests are grouped by pickup stop with waiting times. The driver can acknowledge a request, record boarding, decline pickup, or report no passenger found. Boarding removes the request and increments occupied seats in the same operation. Passenger receipts receive the corresponding message.

## What each source file does

| File | What to explain |
| --- | --- |
| `ShuttleServer.java` | Starts the built-in Java 21 HTTP server, serves the page, and handles the API. Java checks the driver code, calculates available seats, validates pings, and sends commands to Redis using its built-in HTTP client. Gson reads and writes JSON. A Redis script applies the duplicate check and 100-alert limit atomically. |
| `Dockerfile` | Downloads the pinned Gson library, compiles the server with `javac`, and packages the compiled classes and website with Java 21. |
| `vercel.json` | Selects Vercel’s Container runtime so HTTP requests reach the Java server. |
| `public/index.html` | Defines the two main views, the seat counters, the driver form, the pickup location buttons’ container, and the name form. |
| `public/style.css` | Styles the page, highlights the selected view and stop, and lets controls wrap on small screens. |
| `public/script.js` | Switches views, creates a button for each pickup point returned by the server, submits forms with `fetch`, and refreshes the counts and alerts. It displays passenger names as plain text. |
| `how-to-run.txt` | Explains Vercel and Redis setup and how to test the app from two devices. |

## Browser-to-server requests

| Request | Who uses it | What it does |
| --- | --- | --- |
| `GET /api/status` | Anyone | Reads taken seats, available seats, and the pickup locations. |
| `GET /api/shuttles` | Anyone | Reads all three shuttles and their seat counts in one request. |
| `POST /api/driver/session` | Driver with a shuttle code | Unlocks or explicitly takes over a shuttle. |
| `DELETE /api/driver/session` | Current driver | Releases control of the shuttle. |
| `POST /api/alerts` | Passenger | Sends a name and the selected pickup location. |
| `GET /api/dashboard` | Current driver | Reads the fleet, selected trip, alerts, and recent actions in one request. |
| `POST /api/driver/action` | Current driver | Changes the trip, seat count, or pickup outcome with a unique operation ID. |
| `POST /api/pickup-replies` | Passenger with a receipt | Checks for replies to pings sent from the current tab. |

Each new ping returns a private receipt. The passenger’s tab keeps it and the latest received message across reloads. A duplicate ping never reveals another passenger’s receipt. Redis keeps each reply for 30 minutes after the driver sends it. The browser keeps checking the same receipt so an acknowledgement can later become a boarding outcome.

## Shared data

On Vercel, the Java server reads and writes shared state in Upstash Redis. The seat count and its last-updated timestamp survive container restarts. Counts saved before the timestamp feature show a dash until the next update. Up to 100 pickup alerts can be pending at once. Pings expire after 30 minutes and are removed on the next alert read or submission. The driver can dismiss an alert sooner or clear all alerts with **End trip**. Production, Preview, and local development use separate Redis key prefixes.

The server checks a separate code for each shuttle when creating a driver session. It limits failed code attempts to ten per shuttle in five minutes. Subsequent driver requests use a private session token. Session authorization, trip/version checks, seat bounds, and driver writes run together in Redis.

Shuttle-specific requests include an X-Shuttle-Id header with 1, 2, or 3. Omitting it selects Shuttle 1. Shuttle 1 keeps the existing Redis seat keys. Each shuttle now starts in a stopped state until a driver starts a trip. Plate numbers are fictional display labels.

Each driver mutation carries a trip ID, state version, and operation ID. Redis rejects stale versions and remembers completed operation IDs for 24 hours. Repeating a completed request returns the latest state without applying it again. End trip resets seats, clears alerts, and sends a trip-ended message atomically.

The dashboard shows the latest 50 driver actions, retained for seven days after the last action. History contains action, time, and a hashed session reference, with no passenger names. Seat counts older than five minutes are marked for confirmation. The history identifies sessions rather than proving individual driver identities.
