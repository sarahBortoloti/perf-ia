package com.example;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.PostMapping;

@FeignClient(name = "shipping", url = "https://shipping.example.test", path = "/shipping")
public interface ShippingClient {
    @PostMapping("/quote")
    String quote();
}
