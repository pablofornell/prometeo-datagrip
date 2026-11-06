-- Prometeo DataGrip test fixture for MySQL 8 (database "demo"). Idempotent.
SET FOREIGN_KEY_CHECKS = 0;
DROP VIEW IF EXISTS v_order_totals;
DROP TABLE IF EXISTS order_items, orders, customers, products, categories, all_types, big_table;
DROP FUNCTION IF EXISTS order_total;
DROP PROCEDURE IF EXISTS restock;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE categories (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    name      VARCHAR(100) NOT NULL,
    parent_id INT NULL,
    UNIQUE KEY uq_categories_name (name),
    CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL
) COMMENT = 'Product categories';

CREATE TABLE products (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    sku         VARCHAR(32) NOT NULL,
    name        VARCHAR(255) NOT NULL,
    category_id INT NOT NULL,
    price       DECIMAL(10, 2) NOT NULL,
    stock       INT NOT NULL DEFAULT 0,
    tags        JSON NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NULL,
    UNIQUE KEY uq_products_sku (sku),
    KEY idx_products_category (category_id),
    CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id),
    CONSTRAINT products_price_positive CHECK (price > 0)
);

CREATE TABLE customers (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    name       VARCHAR(255) NOT NULL,
    vip        TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_customers_email (email)
);

CREATE TABLE orders (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    status      ENUM('new', 'paid', 'shipped', 'cancelled') NOT NULL DEFAULT 'new',
    placed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note        TEXT NULL,
    KEY idx_orders_customer (customer_id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
);

CREATE TABLE order_items (
    order_id   INT NOT NULL,
    line_no    INT NOT NULL,
    product_id INT NOT NULL,
    qty        INT NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (order_id, line_no),
    CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id),
    CONSTRAINT items_qty_positive CHECK (qty > 0)
);

INSERT INTO categories (name, parent_id) VALUES ('Electronics', NULL), ('Books', NULL), ('Garden', NULL), ('Laptops', 1), ('Phones', 1);

SET SESSION cte_max_recursion_depth = 200000;

INSERT INTO products (sku, name, category_id, price, stock, tags)
WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 20)
SELECT CONCAT('SKU-', LPAD(n, 4, '0')), CONCAT('Product ', n), 1 + (n % 5), ROUND(5 + n * 3.37, 2), (n * 7) % 40,
       IF(n % 3 = 0, JSON_ARRAY('sale', 'new'), JSON_ARRAY('std'))
FROM g;

INSERT INTO customers (email, name, vip)
WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 10)
SELECT CONCAT('customer', n, '@example.com'), CONCAT('Customer ', n), n % 4 = 0 FROM g;

INSERT INTO orders (customer_id, status, placed_at, note)
WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 30)
SELECT 1 + (n % 10), ELT(1 + (n % 4), 'new', 'paid', 'shipped', 'cancelled'), TIMESTAMP('2024-01-01 10:00:00') + INTERVAL n DAY,
       IF(n % 5 = 0, 'gift wrap', NULL)
FROM g;

INSERT INTO order_items (order_id, line_no, product_id, qty, unit_price)
WITH RECURSIVE o (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM o WHERE n < 30),
               l (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM l WHERE n < 3)
SELECT o.n, l.n, 1 + ((o.n * 3 + l.n) % 20), 1 + (o.n + l.n) % 4, ROUND(10 + o.n * 1.5 + l.n, 2) FROM o, l;

CREATE VIEW v_order_totals AS
SELECT o.id AS order_id, c.name AS customer, o.status, SUM(oi.qty * oi.unit_price) AS total
FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, c.name, o.status;

DELIMITER //
CREATE FUNCTION order_total(p_order_id INT) RETURNS DECIMAL(12, 2) READS SQL DATA
BEGIN
    DECLARE t DECIMAL(12, 2);
    SELECT COALESCE(SUM(qty * unit_price), 0) INTO t FROM order_items WHERE order_id = p_order_id;
    RETURN t;
END//

CREATE PROCEDURE restock(IN p_id INT, IN p_qty INT)
BEGIN
    UPDATE products SET stock = stock + p_qty WHERE id = p_id;
END//

CREATE TRIGGER trg_products_touch BEFORE UPDATE ON products FOR EACH ROW
BEGIN
    SET NEW.updated_at = CURRENT_TIMESTAMP;
END//
DELIMITER ;

CREATE TABLE all_types (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    c_tinyint   TINYINT,
    c_smallint  SMALLINT,
    c_mediumint MEDIUMINT,
    c_int       INT,
    c_bigint    BIGINT,
    c_ubigint   BIGINT UNSIGNED,
    c_decimal   DECIMAL(30, 10),
    c_float     FLOAT,
    c_double    DOUBLE,
    c_bit       BIT(8),
    c_bool      TINYINT(1),
    c_char      CHAR(5),
    c_varchar   VARCHAR(40),
    c_text      TEXT,
    c_longtext  LONGTEXT,
    c_binary    BINARY(4),
    c_varbinary VARBINARY(16),
    c_blob      BLOB,
    c_json      JSON,
    c_date      DATE,
    c_time      TIME(3),
    c_datetime  DATETIME(3),
    c_timestamp TIMESTAMP NULL,
    c_year      YEAR,
    c_enum      ENUM('a', 'b', 'c'),
    c_set       SET('x', 'y', 'z'),
    c_point     POINT
);
INSERT INTO all_types (c_tinyint, c_smallint, c_mediumint, c_int, c_bigint, c_ubigint, c_decimal, c_float, c_double, c_bit, c_bool,
    c_char, c_varchar, c_text, c_longtext, c_binary, c_varbinary, c_blob, c_json, c_date, c_time, c_datetime, c_timestamp, c_year,
    c_enum, c_set, c_point)
VALUES (-128, 32767, 8388607, 2147483647, 9223372036854775807, 18446744073709551615, 12345678901234567890.1234567890, 1.5,
    1.2345678901234567, b'10101010', 1, 'ab', 'varchar', 'multi\nline "text" with \'quotes\' and unicode: éñ 😀', 'long', 0xDEADBEEF,
    0x0102, 0xCAFEBABE, '{"a": [1, 2, {"b": null}]}', '2024-02-29', '-12:34:56.789', '2024-02-29 13:45:10.500', '2024-02-29 13:45:10',
    2024, 'b', 'x,z', ST_GeomFromText('POINT(1.5 2.5)'));
INSERT INTO all_types (id) VALUES (2);

CREATE TABLE big_table (
    id      INT PRIMARY KEY,
    grp     INT NOT NULL,
    name    VARCHAR(64) NOT NULL,
    amount  DECIMAL(12, 2) NOT NULL,
    created DATETIME NOT NULL,
    payload VARCHAR(64),
    KEY idx_big_grp (grp)
);
INSERT INTO big_table
WITH RECURSIVE g (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 100000)
SELECT n, n % 100, CONCAT('name-', n), ROUND(n * 1.37, 2), TIMESTAMP('2024-01-01 00:00:00') + INTERVAL n MINUTE, MD5(n) FROM g;
ANALYZE TABLE big_table;
