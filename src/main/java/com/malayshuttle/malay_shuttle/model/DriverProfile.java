package com.malayshuttle.malay_shuttle.model;

import jakarta.persistence.*;

@Entity
@Table(name = "driver_profiles")
public class DriverProfile {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(name = "contact_number", nullable = false, length = 40)
    private String contactNumber;

    @Column(name = "plate_number", nullable = false, length = 30)
    private String plateNumber;

    @Column(nullable = false)
    private boolean active = true;

    protected DriverProfile() {}

    public Long getId() { return id; }
    public String getName() { return name; }
    public String getContactNumber() { return contactNumber; }
    public String getPlateNumber() { return plateNumber; }
    public boolean isActive() { return active; }
}
