package com.malayshuttle.malay_shuttle.controller;

import com.malayshuttle.malay_shuttle.model.RideFeedback;
import com.malayshuttle.malay_shuttle.repository.RideFeedbackRepository;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class RideFeedbackController {
    private final RideFeedbackRepository repository;

    public RideFeedbackController(RideFeedbackRepository repository) {
        this.repository = repository;
    }

    @PostMapping("/feedback")
    public Map<String, String> submit(
            @RequestParam int rating,
            @RequestParam(defaultValue = "") String comment) {
        if (rating < 1 || rating > 5) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Rating must be between 1 and 5");
        }
        if (comment.length() > 1000) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                "Comment exceeds 1000 characters");
        }
        repository.save(new RideFeedback(rating, comment.trim()));
        return Map.of("status", "saved");
    }
}
