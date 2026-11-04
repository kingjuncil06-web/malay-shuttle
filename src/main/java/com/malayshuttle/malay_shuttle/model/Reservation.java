
package com.malayshuttle.malay_shuttle.model;

import jakarta.persistence.*;
import java.time.LocalDate;

@Entity
@Table(
    name = "reservations",
    uniqueConstraints = @UniqueConstraint(
        name = "uk_trip_queue",
        columnNames = {
            "service_date", "departure", "queue_number"
        }
    )
)
public class Reservation {

    @Id
    @Column(name = "booking_id", length = 36)
    private String bookingId;

    @Column(name = "service_date", nullable = false)
    private LocalDate serviceDate;

    @Column(name = "student_name", nullable = false)
    private String studentName;

    @Column(name = "student_id", nullable = false)
    private String studentId;

    @Column(nullable = false)
    private String departure;

    @Column(name = "pickup_point", nullable = false)
    private String pickupPoint;

    @Column(name = "queue_number", nullable = false)
    private int queueNumber;

    @Column(nullable = false)
    private String status;

    protected Reservation() {
        // Required by JPA
    }

    public Reservation(
            String bookingId,
            LocalDate serviceDate,
            String studentName,
            String studentId,
            String departure,
            String pickupPoint,
            int queueNumber) {

        this.bookingId = bookingId;
        this.serviceDate = serviceDate;
        this.studentName = studentName;
        this.studentId = studentId;
        this.departure = departure;
        this.pickupPoint = pickupPoint;
        this.queueNumber = queueNumber;
        this.status = "RESERVED";
    }

    public String getBookingId() {
        return bookingId;
    }

    public LocalDate getServiceDate() {
        return serviceDate;
    }

    public String getStudentName() {
        return studentName;
    }

    public String getStudentId() {
        return studentId;
    }

    public String getDeparture() {
        return departure;
    }

    public String getPickupPoint() {
        return pickupPoint;
    }

    public int getQueueNumber() {
        return queueNumber;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }
}
