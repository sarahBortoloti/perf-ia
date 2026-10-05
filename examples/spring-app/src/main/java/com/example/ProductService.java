package com.example;

import org.springframework.stereotype.Service;

@Service
public class ProductService {
    private final InventoryClient inventory;
    public ProductService(InventoryClient inventory) { this.inventory = inventory; }
    public String list() { return inventory.list(); }
}
