
package com.malayshuttle.malay_shuttle.model;

public class Reservation {

    private String bookingId;
    private String studentName;
    private String studentId;
    private String departure;
    private String pickupPoint;
    private int queueNumber;
    private String status;

    public Reservation(String bookingId, String studentName,
                       String studentId, String departure,
                       String pickupPoint, int queueNumber) {
        this.bookingId = bookingId;
        this.studentName = studentName;
        this.studentId = studentId;
        this.departure = departure;
        this.pickupPoint = pickupPoint;
        this.queueNumber = queueNumber;
        this.status = "RESERVED";
    }

    public String getBookingId() { return bookingId; }
    public String getStudentName() { return studentName; }
    public String getStudentId() { return studentId; }
    public String getDeparture() { return departure; }
    public String getPickupPoint() { return pickupPoint; }
    public int getQueueNumber() { return queueNumber; }
    public String getStatus() { return status; }

    public void setStatus(String status) {
        this.status = status;
    }
}
