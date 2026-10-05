package com.example;

import org.springframework.stereotype.Service;

@Service
public class ProductService {
    private final InventoryClient inventory;
    private final ShippingClient shipping;
    public ProductService(InventoryClient inventory, ShippingClient shipping) {
        this.inventory = inventory;
        this.shipping = shipping;
    }
    public String list() {
        String products = inventory.list();
        shipping.quote();
        return products;
    }
}
