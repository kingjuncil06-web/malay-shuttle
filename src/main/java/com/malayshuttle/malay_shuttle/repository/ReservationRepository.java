
package com.malayshuttle.malay_shuttle.repository;

import com.malayshuttle.malay_shuttle.model.Reservation;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface ReservationRepository
        extends JpaRepository<Reservation, String> {

    long countByServiceDateAndDepartureAndStatusNot(
            LocalDate serviceDate,
            String departure,
            String status
    );

    boolean existsByServiceDateAndDepartureAndStudentIdIgnoreCaseAndStatusNot(
            LocalDate serviceDate,
            String departure,
            String studentId,
            String status
    );

    Optional<Reservation>
        findTopByServiceDateAndDepartureOrderByQueueNumberDesc(
            LocalDate serviceDate,
            String departure
        );

    List<Reservation>
        findByServiceDateAndStudentIdIgnoreCaseOrderByQueueNumberAsc(
            LocalDate serviceDate,
            String studentId
        );

    Optional<Reservation>
        findByBookingIdAndStudentIdIgnoreCase(
            String bookingId,
            String studentId
        );
}
