
package com.malayshuttle.malay_shuttle.controller;

import com.malayshuttle.malay_shuttle.model.Reservation;
import com.malayshuttle.malay_shuttle.service.ReservationService;

import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class ReservationController {

    private final ReservationService service;

    private final Set<String> departures = Set.of(
        "6:10 AM", "7:20 AM", "8:45 AM",
        "10:00 AM", "11:20 AM", "12:20 PM",
        "1:45 PM"
    );

    private final Set<String> pickupPoints = Set.of(
        "Pacita Astrodome",
        "Ukay-Ukay beside Savemore",
        "Uncle John's Maria Aurora"
    );

    public ReservationController(ReservationService service) {
        this.service = service;
    }

    @GetMapping("/seats")
    public Map<String, Integer> getSeats(
            @RequestParam String departure) {

        validateDeparture(departure);

        return Map.of("available", service.available(departure));
    }

    @PostMapping("/reserve")
    public Reservation reserve(
            @RequestParam String departure,
            @RequestParam String studentName,
            @RequestParam String studentId,
            @RequestParam String pickupPoint) {

        validateDeparture(departure);

        if (!pickupPoints.contains(pickupPoint)) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST, "Invalid pickup point");
        }

        if (studentName.isBlank() || studentId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST, "Student information is required");
        }

        try {
            return service.reserve(
                departure,
                studentName.trim(),
                studentId.trim(),
                pickupPoint
            );
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT, e.getMessage());
        }
    }

    @GetMapping("/bookings")
    public List<Reservation> getBookings(
            @RequestParam String studentId) {

        if (studentId.isBlank()) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST, "Student ID is required");
        }

        return service.getBookings(studentId.trim());
    }

    @PostMapping("/cancel")
    public Reservation cancel(
            @RequestParam String bookingId,
            @RequestParam String studentId) {

        try {
            return service.cancel(bookingId, studentId.trim());
        } catch (java.util.NoSuchElementException e) {
            throw new ResponseStatusException(
                HttpStatus.NOT_FOUND, e.getMessage());
        } catch (IllegalStateException e) {
            throw new ResponseStatusException(
                HttpStatus.CONFLICT, e.getMessage());
        }
    }

    private void validateDeparture(String departure) {
        if (!departures.contains(departure)) {
            throw new ResponseStatusException(
                HttpStatus.BAD_REQUEST, "Invalid departure");
        }
    }
}
