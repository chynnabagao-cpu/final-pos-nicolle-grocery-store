# POS System Database Schema (MySQL)

This application uses MySQL to store its data. Below is the detailed schema for all tables.

## 1. `stores`
Stores the different store locations.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `name`: VARCHAR(255), NOT NULL
- `address`: TEXT
- `phone`: VARCHAR(50)
- `is_active`: TINYINT, DEFAULT 1
- `created_at`: TIMESTAMP, DEFAULT CURRENT_TIMESTAMP

## 2. `users`
System users (admins and staff).
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `username`: VARCHAR(255), UNIQUE, NOT NULL
- `password`: VARCHAR(255), NOT NULL
- `role`: ENUM('admin', 'user'), NOT NULL
- `full_name`: VARCHAR(255), NOT NULL
- `store_id`: INT, FOREIGN KEY (stores.id)

## 3. `categories`
Product categories belonging to specific stores.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `name`: VARCHAR(255), NOT NULL
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- UNIQUE(name, store_id)

## 4. `products`
Inventory items.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `name`: VARCHAR(255), NOT NULL
- `barcode`: VARCHAR(255), NOT NULL
- `category_id`: INT, FOREIGN KEY (categories.id)
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- `cost_price`: DECIMAL(15, 2), NOT NULL
- `selling_price`: DECIMAL(15, 2), NOT NULL
- `stock_quantity`: INT, DEFAULT 0
- `min_stock_level`: INT, DEFAULT 10
- `expiration_date`: DATE
- `image_url`: TEXT

## 5. `sales`
Transaction headers.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `user_id`: INT, NOT NULL, FOREIGN KEY (users.id)
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- `total_amount`: DECIMAL(15, 2), NOT NULL
- `discount_amount`: DECIMAL(15, 2), DEFAULT 0
- `payment_method`: VARCHAR(50), NOT NULL
- `cash_received`: DECIMAL(15, 2)
- `change_given`: DECIMAL(15, 2)
- `payment_details`: TEXT
- `created_at`: TIMESTAMP, DEFAULT CURRENT_TIMESTAMP

## 6. `sale_items`
Individual items within a sale.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `sale_id`: INT, NOT NULL, FOREIGN KEY (sales.id)
- `product_id`: INT, NOT NULL, FOREIGN KEY (products.id)
- `quantity`: INT, NOT NULL
- `unit_price`: DECIMAL(15, 2), NOT NULL
- `discount_amount`: DECIMAL(15, 2), DEFAULT 0
- `subtotal`: DECIMAL(15, 2), NOT NULL

## 7. `inventory_logs`
Tracking history of stock changes.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `product_id`: INT, NOT NULL, FOREIGN KEY (products.id)
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- `change_amount`: INT, NOT NULL (Positive for stock-in, negative for stock-out)
- `reason`: TEXT
- `created_at`: TIMESTAMP, DEFAULT CURRENT_TIMESTAMP

## 8. `discounts`
Available promotions.
- `id`: INT, PRIMARY KEY, AUTO_INCREMENT
- `name`: VARCHAR(255), NOT NULL
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- `type`: ENUM('percentage', 'fixed'), NOT NULL
- `value`: DECIMAL(15, 2), NOT NULL
- `target_type`: ENUM('product', 'category', 'all'), NOT NULL
- `target_id`: INT
- `start_date`: DATE
- `end_date`: DATE
- `is_active`: TINYINT, DEFAULT 1

## 9. `settings`
System and store configurations.
- `key`: VARCHAR(255), NOT NULL
- `value`: TEXT, NOT NULL
- `store_id`: INT, NOT NULL, FOREIGN KEY (stores.id)
- PRIMARY KEY (`key`, store_id)
