# MALAY-SHUTTLE source guide

MALAY-SHUTTLE displays the seat count for one shuttle. A driver enters the number of occupied seats, and passengers can tell the driver they are still waiting at a pickup point.

## How the app works

1. **Check seats.** The browser asks the server for the current count. If 9 of 15 seats are taken, the server sends back 9 taken and 6 available. The browser refreshes about every 30 seconds while its tab is visible and checks again when you return to the tab.
2. **Update seats.** The driver opens **Driver controls**, enters the shared driver code, and submits the occupied count. The server checks the code and accepts a whole number from 0 to 15.
3. **Send a pickup alert.** The passenger opens **Pickup ping**, selects a location tab, enters their name, and presses **I’m still at the pickup point**. The location comes from the selected tab. The browser does not ask for GPS access.
4. **Read and dismiss an alert.** The driver’s browser checks for alerts while the driver controls are open and the code is entered. A new ping appears in the list on the page. The driver can dismiss it after responding. If the same name pings the same stop while an alert is pending, the server keeps one entry.

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
| `PUT /api/status` | Driver | Saves the occupied seat count. |
| `POST /api/alerts` | Passenger | Sends a name and the selected pickup location. |
| `GET /api/alerts` | Driver | Reads pending alerts. |
| `GET /api/dashboard` | Driver | Reads the seat count and pending alerts in a single request. |
| `POST /api/trip/end` | Driver | Resets occupied seats to zero and clears pickup alerts together. |
| `DELETE /api/alerts/{id}` | Driver | Dismisses one pending alert. |
| `POST /api/alerts/{id}/decline` | Driver | Sends a private “Can’t pick up” reply and removes the pending alert. |
| `POST /api/pickup-replies` | Passenger with a receipt | Checks for replies to pings sent from the current tab. |

Each new ping returns a private receipt. The passenger’s tab keeps it across reloads and checks for replies during the usual refresh. A duplicate ping never reveals another passenger’s receipt. Redis keeps each reply for 30 minutes after the driver sends it.

## Shared data

On Vercel, the Java server reads and writes shared state in Upstash Redis. The seat count and its last-updated timestamp survive container restarts. Counts saved before the timestamp feature show a dash until the next update. Up to 100 pickup alerts can be pending at once. Pings expire after 30 minutes and are removed on the next alert read or submission. The driver can dismiss an alert sooner or clear all alerts with **End trip**. Production, Preview, and local development use separate Redis key prefixes.

Passengers type their own names. The driver code is checked on the server before the driver can update seats, view names, or dismiss alerts.
