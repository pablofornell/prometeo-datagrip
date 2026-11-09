-- Migration: make B like A (MySQL)
-- Generated from the schema compare. Review it before you run it.
-- Statements that drop objects are included.

USE `cmpx_b`;

-- table tag: create (from A)
CREATE TABLE `tag` (
  `id` int NOT NULL,
  `name` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `tag_name_ix` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table item_tag: create (from A)
CREATE TABLE `item_tag` (
  `item_id` int NOT NULL,
  `tag_id` int NOT NULL,
  PRIMARY KEY (`item_id`,`tag_id`),
  KEY `item_tag_tag_fk` (`tag_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table audit: create (from A)
CREATE TABLE `audit` (
  `id` int NOT NULL,
  `emp_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `audit_emp_fk` (`emp_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- table order_lines: foreign key order_lines_order_fk (dropped before primary key (id) is replaced)
ALTER TABLE `order_lines` DROP FOREIGN KEY `order_lines_order_fk`;

-- table emp: check emp_salary_ck: replace
ALTER TABLE `emp` DROP CHECK `emp_salary_ck`;

-- table emp: index emp_name_ix: replace
DROP INDEX `emp_name_ix` ON `emp`;

-- table emp: index emp_old_ix (only in B)
DROP INDEX `emp_old_ix` ON `emp`;

-- table orders: primary key (id, ref): replace
ALTER TABLE `orders` DROP PRIMARY KEY;

-- table emp: change column name
ALTER TABLE `emp` MODIFY COLUMN `name` varchar(80) NOT NULL;

-- table emp: change column code
ALTER TABLE `emp` MODIFY COLUMN `code` varchar(10);

-- table emp: change column salary
ALTER TABLE `emp` MODIFY COLUMN `salary` decimal(10,2) DEFAULT 0;

-- table emp: add column status
ALTER TABLE `emp` ADD COLUMN `status` varchar(10) DEFAULT 'new' NOT NULL;

-- table dept: add unique dept_name_key
ALTER TABLE `dept` ADD CONSTRAINT `dept_name_key` UNIQUE (`name`);

-- table emp: add unique emp_code_key
ALTER TABLE `emp` ADD CONSTRAINT `emp_code_key` UNIQUE (`code`);

-- table emp: check emp_salary_ck: replace
ALTER TABLE `emp` ADD CONSTRAINT `emp_salary_ck` CHECK ((`salary` >= 0));

-- table orders: primary key (id, ref): replace
ALTER TABLE `orders` ADD PRIMARY KEY (`id`, `ref`);

-- table orders: add unique orders_id_uq
ALTER TABLE `orders` ADD CONSTRAINT `orders_id_uq` UNIQUE (`id`);

-- table order_lines: foreign key order_lines_order_fk: add again after the key is replaced
ALTER TABLE `order_lines` ADD CONSTRAINT `order_lines_order_fk` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`);

-- table item_tag: foreign key item_tag_tag_fk
ALTER TABLE `item_tag` ADD CONSTRAINT `item_tag_tag_fk` FOREIGN KEY (`tag_id`) REFERENCES `tag` (`id`);

-- table audit: foreign key audit_emp_fk
ALTER TABLE `audit` ADD CONSTRAINT `audit_emp_fk` FOREIGN KEY (`emp_id`) REFERENCES `emp` (`id`);

-- table emp: index emp_name_ix: replace
CREATE INDEX `emp_name_ix` ON `emp` (`name`);

-- view v_emp: replace
CREATE OR REPLACE VIEW `v_emp` AS select `emp`.`id` AS `id`,`emp`.`name` AS `name` from `emp`;

-- table emp: drop column old_flag (only in B)
ALTER TABLE `emp` DROP COLUMN `old_flag`;

-- table old_log: only in B
DROP TABLE `old_log`;
