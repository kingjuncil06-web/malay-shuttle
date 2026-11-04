package com.malayshuttle.malay_shuttle.repository;

import com.malayshuttle.malay_shuttle.model.DriverProfile;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface DriverProfileRepository extends JpaRepository<DriverProfile, Long> {
    List<DriverProfile> findByActiveTrueOrderByNameAsc();
}
