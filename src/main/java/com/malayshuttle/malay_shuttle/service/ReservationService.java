
package com.malayshuttle.malay_shuttle.service;

import com.malayshuttle.malay_shuttle.model.Reservation;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;

import org.springframework.stereotype.Service;

@Service
public class ReservationService {

    private static final int CAPACITY = 15;
    private static final ZoneId PH_TIME =
            ZoneId.of("Asia/Manila");

    private final Map<String, List<Reservation>> trips =
            new HashMap<>();

    private final Map<String, Integer> nextQueueNumbers =
            new HashMap<>();

    private String tripKey(String departure) {
        return LocalDate.now(PH_TIME) + "_" + departure;
    }

    public synchronized Reservation reserve(
            String departure,
            String studentName,
            String studentId,
            String pickupPoint) {

        String key = tripKey(departure);
        List<Reservation> reservations =
                trips.computeIfAbsent(key, k -> new ArrayList<>());

        long active = reservations.stream()
                .filter(r -> !r.getStatus().equals("CANCELLED"))
                .count();

        if (active >= CAPACITY) {
            throw new IllegalStateException(
                    "This shuttle is fully booked.");
        }

        boolean duplicate = reservations.stream()
                .anyMatch(r ->
                        r.getStudentId().equalsIgnoreCase(studentId)
                        && !r.getStatus().equals("CANCELLED"));

        if (duplicate) {
            throw new IllegalStateException(
                    "You already have a reservation for this trip.");
        }

        int queue = nextQueueNumbers.merge(key, 1, Integer::sum);

        Reservation reservation = new Reservation(
                UUID.randomUUID().toString(),
                studentName,
                studentId,
                departure,
                pickupPoint,
                queue
        );

        reservations.add(reservation);
        return reservation;
    }

    public synchronized int available(String departure) {
        List<Reservation> reservations =
                trips.getOrDefault(tripKey(departure), List.of());

        long active = reservations.stream()
                .filter(r -> !r.getStatus().equals("CANCELLED"))
                .count();

        return CAPACITY - (int) active;
    }

    public synchronized List<Reservation> getBookings(
            String studentId) {

        String todayPrefix = LocalDate.now(PH_TIME) + "_";

        return trips.entrySet().stream()
                .filter(e -> e.getKey().startsWith(todayPrefix))
                .flatMap(e -> e.getValue().stream())
                .filter(r -> r.getStudentId()
                        .equalsIgnoreCase(studentId))
                .toList();
    }

    public synchronized Reservation cancel(
            String bookingId, String studentId) {

        for (List<Reservation> reservations : trips.values()) {
            for (Reservation r : reservations) {
                if (r.getBookingId().equals(bookingId)
                        && r.getStudentId().equalsIgnoreCase(studentId)) {

                    if (!r.getStatus().equals("RESERVED")) {
                        throw new IllegalStateException(
                                "This booking cannot be cancelled.");
                    }

                    r.setStatus("CANCELLED");
                    return r;
                }
            }
        }

        throw new NoSuchElementException(
                "Reservation not found.");
    }
}
