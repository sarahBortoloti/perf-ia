package com.example;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;

@FeignClient(name = "inventory", url = "${inventory.url}", path = "/inventory")
public interface InventoryClient {
    @GetMapping("/products")
    String list();
}
