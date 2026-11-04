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
| `vercel.json` | Tells Vercel where to find the website files and routes alert dismissals to the alerts function. |
| `api/status.mjs` | Reads or updates the Redis seat count and calculates available seats. |
| `api/alerts.mjs` | Accepts pings, lists them for the driver, and dismisses them. A Redis script checks for a duplicate and applies the 100-alert limit in the same operation as saving a new ping. |
| `lib/shuttle.mjs` | Holds the capacity and pickup locations, checks the driver code, and sends Redis commands over HTTPS. |
| `MalayShuttleApplication.java` | Java entry point for the local demo. `SpringApplication.run` starts Spring Boot and its web server. |
| `ShuttleController.java` | Implements the same API for the local demo using memory. The synchronized methods let one request at a time change or read the shuttle state. |
| `index.html` | Defines the two main views, the seat counters, the driver form, the pickup location buttons’ container, and the name form. |
| `style.css` | Styles the page, highlights the selected view and stop, and lets controls wrap on small screens. |
| `script.js` | Switches views, creates a button for each pickup point returned by the server, submits forms with `fetch`, and refreshes the counts and alerts. It displays passenger names as plain text. |
| `application.properties` | Sets the server port to 8080, reads the driver code from the environment, and rejects fractional values where the API expects a whole number. |
| `pom.xml` | Tells Maven to use Java 21 and Spring Boot, with dependencies for HTTP, JSON, and tests. |
| `mvnw.cmd` and `mvnw` | Maven launchers for Windows and Unix-like systems. |
| `MalayShuttleApplicationTests.java` | Sends simulated HTTP requests through Spring MVC to check the public page, seat updates, and the pickup alert lifecycle. |
| `how-to-run.txt` | Explains Vercel and Redis setup and gives the PowerShell commands for a local demo. |

## Browser-to-server requests

| Request | Who uses it | What it does |
| --- | --- | --- |
| `GET /api/status` | Anyone | Reads taken seats, available seats, and the pickup locations. |
| `PUT /api/status` | Driver | Saves the occupied seat count. |
| `POST /api/alerts` | Passenger | Sends a name and the selected pickup location. |
| `GET /api/alerts` | Driver | Reads pending alerts. |
| `DELETE /api/alerts/{id}` | Driver | Dismisses one pending alert. |

## Hosted and local data

On Vercel, each request runs a function that reads or writes shared state in Upstash Redis. The seat count and up to 100 pending alerts survive function restarts. Alerts stay pending until the driver dismisses them. The local Spring Boot demo starts with zero occupied seats and clears alerts on restart. The two environments use separate data.

Passengers type their own names. The driver code is checked on the server before the driver can update seats, view names, or dismiss alerts.
