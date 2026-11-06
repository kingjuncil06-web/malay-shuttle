# MALAY-SHUTTLE source guide

MALAY-SHUTTLE displays independent seat counts for three 15-seat shuttles on the same four-stop route. The Passenger panel shows each shuttle’s plate number. Passengers choose a shuttle before pinging its driver. The Driver panel manages the selected shuttle’s seats and alerts.

## How the app works

1. **Check seats.** The browser asks the server for the current count. If 9 of 15 seats are taken, the server sends back 9 taken and 6 available. The browser refreshes about every 30 seconds while its tab is visible and checks again when you return to the tab.
2. **Update seats.** The driver unlocks the selected shuttle with its own code and starts a trip with a confirmed occupied count. The server accepts counts from 0 to 15, binds updates to the current trip, and rejects stale state versions. One session controls each shuttle for up to eight hours. Explicit takeover invalidates the previous session.
3. **Send a pickup alert.** The Passenger panel assigns a private browser ID in an HTTP-only cookie. A passenger selects a shuttle and stop, enters a name, and sends one request. Redis enforces one active request across the fleet and 60 seconds between submissions. Different passengers may use the same name.
4. **Handle an alert.** Requests are grouped by pickup stop with waiting times. The driver can acknowledge a request, record boarding, decline pickup, or report no passenger found. Boarding removes the request and increments occupied seats in the same operation. Passenger receipts receive the corresponding message.

## What each source file does

| File | What to explain |
| --- | --- |
| `ShuttleServer.java` | Starts the built-in Java 21 HTTP server, serves the page, and handles the API. Java checks driver sessions, calculates available seats, validates pings, and sends commands to Redis using its built-in HTTP client. Gson reads and writes JSON. Redis scripts apply passenger limits and driver updates atomically. |
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
| `GET /api/passenger` | Passenger browser | Creates its private cookie when needed and reads its current request and cooldown. |
| `POST /api/passenger/cancel` | Passenger browser | Cancels its current request without clearing the submission cooldown. |
| `POST /api/passenger/confirm` | Passenger browser | Confirms it is still waiting and extends its request by five minutes. |
| `GET /api/dashboard` | Current driver | Reads the fleet, selected trip, alerts, and recent actions in one request. |
| `POST /api/driver/action` | Current driver | Changes the trip, seat count, or pickup outcome with a unique operation ID. |
| `POST /api/pickup-replies` | Passenger with a receipt | Checks for replies to pings sent from the current tab. |

Each new ping returns its private current-request state, including a reply receipt. The browser cookie also lets another tab recover that browser's current request. The tab keeps received messages across reloads. Redis keeps each reply for 30 minutes after the driver sends it. The browser keeps checking an active receipt so an acknowledgement can later become a boarding outcome.

## Shared data

On Vercel, the Java server reads and writes shared state in Upstash Redis. The seat count and its last-updated timestamp survive container restarts. Counts saved before the timestamp feature show a dash until the next update. Up to 100 pickup alerts per shuttle can be pending. Requests expire after five minutes unless explicitly reconfirmed. Expired entries are removed on an alert read or submission. End trip clears pending requests and informs those passengers. Production, Preview, and local development use separate Redis key prefixes.

The Passenger panel reminds the user after four minutes to tap **Still waiting**. Confirmation extends the request for five minutes and can happen at most once per minute. Cancellation requires the current request ID, so a delayed action from another tab cannot cancel a newer request. Submission IDs are remembered for one hour to handle retries without adding another request. Names are display labels rather than identities.

The private cookie lasts 30 days, uses SameSite Strict, and is Secure in Vercel Production and Preview. Requests require cookies. Clearing cookies, changing browsers, or using another device can bypass a browser identity, and this feature does not establish physical presence at the pickup point.

The server checks a separate code for each shuttle when creating a driver session. It limits failed code attempts to ten per shuttle in five minutes. Subsequent driver requests use a private session token. Session authorization, trip/version checks, seat bounds, and driver writes run together in Redis.

Shuttle-specific requests include an X-Shuttle-Id header with 1, 2, or 3. Omitting it selects Shuttle 1. Shuttle 1 keeps the existing Redis seat keys. Each shuttle now starts in a stopped state until a driver starts a trip.

Each driver mutation carries a trip ID, state version, and operation ID. Redis rejects stale versions and remembers completed operation IDs for 24 hours. Repeating a completed request returns the latest state without applying it again. End trip resets seats, clears alerts, and sends a trip-ended message atomically.

The dashboard shows the latest 50 driver actions, retained for seven days after the last action. History contains action, time, and a hashed session reference, with no passenger names. Seat counts older than five minutes are marked for confirmation. The history identifies sessions rather than proving individual driver identities.
