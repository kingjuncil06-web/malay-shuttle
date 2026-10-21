
package com.malayshuttle.malay_shuttle.controller;

import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class HomeController {

    @GetMapping("/")
    public String home(Model model) {
        LocalDate today = LocalDate.now(
            ZoneId.of("Asia/Manila")
        );

        String date = today.format(
            DateTimeFormatter.ofPattern(
                "EEEE, MMMM d, yyyy",
                Locale.ENGLISH
            )
        );

        model.addAttribute("currentDate", date);
        model.addAttribute("today", today.toString());

        return "index";
    }
}
