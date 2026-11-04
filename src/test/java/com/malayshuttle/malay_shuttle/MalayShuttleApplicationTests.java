package com.malayshuttle.malay_shuttle;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.context.WebApplicationContext;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.springframework.test.web.servlet.setup.MockMvcBuilders.webAppContextSetup;

@SpringBootTest(properties = "shuttle.driver-code=test-code")
class MalayShuttleApplicationTests {
    @Autowired
    private WebApplicationContext context;

    @Test
    void driverUpdatesSeatsAndReceivesPassengerPing() throws Exception {
        var app = webAppContextSetup(context).build();
        app.perform(get("/")).andExpect(status().isOk());
        app.perform(get("/api/status")).andExpect(jsonPath("$.available").value(15));
        app.perform(seats("wrong", "9")).andExpect(status().isForbidden());
        app.perform(seats("test-code", "16")).andExpect(status().isBadRequest());
        app.perform(seats("test-code", "1.5")).andExpect(status().isBadRequest());
        app.perform(seats("test-code", "9"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.taken").value(9))
            .andExpect(jsonPath("$.available").value(6));

        String ping = "{\"name\":\"Jamie\",\"stop\":\"Southwoods\"}";
        app.perform(post("/api/alerts").contentType("application/json").content(ping))
            .andExpect(status().isNoContent());
        app.perform(post("/api/alerts").contentType("application/json").content(ping))
            .andExpect(status().isNoContent());
        app.perform(get("/api/alerts").header("X-Driver-Code", "wrong")).andExpect(status().isForbidden());
        app.perform(get("/api/alerts").header("X-Driver-Code", "test-code"))
            .andExpect(jsonPath("$.length()").value(1))
            .andExpect(jsonPath("$[0].name").value("Jamie"))
            .andExpect(jsonPath("$[0].stop").value("Southwoods"));
        app.perform(delete("/api/alerts/1").header("X-Driver-Code", "test-code"))
            .andExpect(status().isNoContent());
        app.perform(get("/api/alerts").header("X-Driver-Code", "test-code"))
            .andExpect(jsonPath("$.length()").value(0));
    }

    private MockHttpServletRequestBuilder seats(String code, String count) {
        return put("/api/status").header("X-Driver-Code", code)
            .contentType("application/json").content("{\"taken\":" + count + "}");
    }
}
