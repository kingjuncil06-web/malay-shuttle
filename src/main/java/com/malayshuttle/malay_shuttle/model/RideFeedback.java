package com.malayshuttle.malay_shuttle.model;

import jakarta.persistence.*;
import java.time.Instant;

@Entity
@Table(name = "ride_feedback")
public class RideFeedback {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private int rating;

    @Column(length = 1000)
    private String comment;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected RideFeedback() {}

    public RideFeedback(int rating, String comment) {
        this.rating = rating;
        this.comment = comment;
        this.createdAt = Instant.now();
    }

    public Long getId() { return id; }
    public int getRating() { return rating; }
    public String getComment() { return comment; }
    public Instant getCreatedAt() { return createdAt; }
}
