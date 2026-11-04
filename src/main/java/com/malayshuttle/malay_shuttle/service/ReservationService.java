
package com.malayshuttle.malay_shuttle.service;

import com.malayshuttle.malay_shuttle.model.Reservation;
import com.malayshuttle.malay_shuttle.repository.ReservationRepository;

import jakarta.persistence.EntityManager;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ReservationService {

    private static final int CAPACITY = 15;

    private static final ZoneId PH_TIME =
            ZoneId.of("Asia/Manila");

    private final ReservationRepository repository;
    private final EntityManager entityManager;

    public ReservationService(
            ReservationRepository repository,
            EntityManager entityManager) {

        this.repository = repository;
        this.entityManager = entityManager;
    }

    private LocalDate today() {
        return LocalDate.now(PH_TIME);
    }

    @Transactional
    public Reservation reserve(
            String departure,
            String studentName,
            String studentId,
            String pickupPoint) {

        // Lock a single database row until
        // the reservation transaction finishes.
        // This protects against concurrent overbooking.
        entityManager.createNativeQuery(
            "SELECT id FROM booking_mutex " +
            "WHERE id = 1 FOR UPDATE"
        ).getSingleResult();

        LocalDate date = today();

        long active =
                repository.countByServiceDateAndDepartureAndStatusNot(
                    date,
                    departure,
                    "CANCELLED"
                );

        if (active >= CAPACITY) {
            throw new IllegalStateException(
                "This shuttle is fully booked."
            );
        }

        boolean duplicate =
                repository.existsByServiceDateAndDepartureAndStudentIdIgnoreCaseAndStatusNot(
                    date,
                    departure,
                    studentId,
                    "CANCELLED"
                );

        if (duplicate) {
            throw new IllegalStateException(
                "You already have a reservation for this trip."
            );
        }

        int nextQueue = repository
            .findTopByServiceDateAndDepartureOrderByQueueNumberDesc(
                date, departure
            )
            .map(r -> r.getQueueNumber() + 1)
            .orElse(1);

        Reservation reservation = new Reservation(
            UUID.randomUUID().toString(),
            date,
            studentName,
            studentId,
            departure,
            pickupPoint,
            nextQueue
        );

        return repository.saveAndFlush(reservation);
    }

    @Transactional(readOnly = true)
    public int available(String departure) {

        long active =
                repository.countByServiceDateAndDepartureAndStatusNot(
                    today(),
                    departure,
                    "CANCELLED"
                );

        return Math.max(0, CAPACITY - (int) active);
    }

    @Transactional(readOnly = true)
    public List<Reservation> getBookings(
            String studentId) {

        return repository
            .findByServiceDateAndStudentIdIgnoreCaseOrderByQueueNumberAsc(
                today(),
                studentId
            );
    }

    @Transactional
    public Reservation cancel(
            String bookingId,
            String studentId) {

        Reservation reservation = repository
            .findByBookingIdAndStudentIdIgnoreCase(
                bookingId,
                studentId
            )
            .orElseThrow(() ->
                new NoSuchElementException(
                    "Reservation not found."
                )
            );

        if (!reservation.getStatus().equals("RESERVED")) {
            throw new IllegalStateException(
                "This booking cannot be cancelled."
            );
        }

        reservation.setStatus("CANCELLED");

        return repository.save(reservation);
    }
}
