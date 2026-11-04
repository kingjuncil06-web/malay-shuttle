package com.malayshuttle.malay_shuttle.controller;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class ShuttleController {
    private static final int CAPACITY = 15;
    private static final int MAX_ALERTS = 100;
    private static final List<String> STOPS = List.of(
        "Pacita Astrodome", "Ukay-Ukay beside Savemore", "Uncle John's Maria Aurora", "Southwoods"
    );

    private final String driverCode;
    private final Map<Long, PickupAlert> alerts = new LinkedHashMap<>();
    private int taken;
    private long nextAlertId;

    public ShuttleController(@Value("${shuttle.driver-code:}") String driverCode) {
        this.driverCode = driverCode;
    }

    @GetMapping("/status")
    public synchronized Status status() {
        return new Status(taken, CAPACITY - taken, STOPS);
    }

    @PutMapping("/status")
    public synchronized Status updateSeats(@RequestHeader("X-Driver-Code") String code,
                                          @RequestBody SeatUpdate update) {
        requireDriver(code);
        if (update.taken() == null || update.taken() < 0 || update.taken() > CAPACITY) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid seat count");
        }
        taken = update.taken();
        return status();
    }

    @PostMapping("/alerts")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public synchronized void ping(@RequestBody Ping ping) {
        String name = ping.name() == null ? "" : ping.name().strip();
        if (name.isBlank() || name.length() > 60 || ping.stop() == null || !STOPS.contains(ping.stop())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid name or pickup point");
        }
        for (PickupAlert alert : alerts.values()) {
            if (alert.stop().equals(ping.stop()) && alert.name().equalsIgnoreCase(name)) {
                return;
            }
        }
        if (alerts.size() >= MAX_ALERTS) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Pickup alert list is full");
        }
        long id = ++nextAlertId;
        alerts.put(id, new PickupAlert(id, name, ping.stop()));
    }

    @GetMapping("/alerts")
    public synchronized List<PickupAlert> alerts(@RequestHeader("X-Driver-Code") String code) {
        requireDriver(code);
        return List.copyOf(alerts.values());
    }

    @DeleteMapping("/alerts/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public synchronized void dismiss(@RequestHeader("X-Driver-Code") String code, @PathVariable long id) {
        requireDriver(code);
        alerts.remove(id);
    }

    private void requireDriver(String code) {
        if (driverCode.isBlank() || !driverCode.equals(code)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        }
    }

    public record Status(int taken, int available, List<String> stops) {}
    public record SeatUpdate(Integer taken) {}
    public record Ping(String name, String stop) {}
    public record PickupAlert(long id, String name, String stop) {}
}
