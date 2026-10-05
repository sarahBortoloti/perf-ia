package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/products")
public class ProductController {
    private final ProductService service;

    public ProductController(ProductService service) { this.service = service; }

    @GetMapping
    public String list() { return service.list(); }

    @PostMapping
    public String create(@RequestBody String product) { return product; }

    @PutMapping("/{id}")
    public String update(@PathVariable String id, @RequestBody String product) { return product; }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) {}
}
