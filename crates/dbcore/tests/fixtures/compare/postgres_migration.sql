-- Migration: make B like A (PostgreSQL)
-- Generated from the schema compare. Review it before you run it.
-- Statements that drop objects are included.

SET search_path TO "cmpx_b";

-- table tag: create (from A)
-- auto-generated definition
create table tag
(
    id   integer not null
        primary key,
    name varchar(20)
);

create index tag_name_ix on tag using btree (name);

-- table item_tag: create (from A)
-- auto-generated definition
create table item_tag
(
    item_id integer not null,
    tag_id  integer not null,
    constraint item_tag_pkey primary key (item_id, tag_id)
);

-- table audit: create (from A)
-- auto-generated definition
create table audit
(
    id     integer not null
        primary key,
    emp_id integer not null
);

-- table order_lines: foreign key order_lines_order_fk (dropped before primary key (id) is replaced)
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_order_fk";

-- table emp: check emp_salary_ck: replace
ALTER TABLE "emp" DROP CONSTRAINT "emp_salary_ck";

-- table emp: index emp_name_ix: replace
DROP INDEX "emp_name_ix";

-- table emp: index emp_salary_ix: replace
DROP INDEX "emp_salary_ix";

-- table emp: index emp_old_ix (only in B)
DROP INDEX "emp_old_ix";

-- table orders: primary key (id) (replaced: same definition in A under another name)
ALTER TABLE "orders" DROP CONSTRAINT "orders_pkey_old";

-- table emp: change column name
ALTER TABLE "emp" ALTER COLUMN "name" TYPE varchar(80);

-- table emp: change column name
ALTER TABLE "emp" ALTER COLUMN "name" SET NOT NULL;

-- table emp: change column code
ALTER TABLE "emp" ALTER COLUMN "code" DROP NOT NULL;

-- table emp: change column salary
ALTER TABLE "emp" ALTER COLUMN "salary" SET DEFAULT 0;

-- table emp: add column status
ALTER TABLE "emp" ADD COLUMN "status" varchar(10) DEFAULT 'new'::character varying NOT NULL;

-- table dept: add unique dept_name_key
ALTER TABLE "dept" ADD CONSTRAINT "dept_name_key" UNIQUE ("name");

-- table emp: add unique emp_code_key
ALTER TABLE "emp" ADD CONSTRAINT "emp_code_key" UNIQUE ("code");

-- table emp: check emp_salary_ck: replace
ALTER TABLE "emp" ADD CONSTRAINT "emp_salary_ck" CHECK ((salary >= (0)::numeric));

-- table orders: add primary key (id)
ALTER TABLE "orders" ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");

-- table order_lines: foreign key order_lines_order_fk: add again after the key is replaced
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_fk" FOREIGN KEY ("order_id") REFERENCES "orders" ("id");

-- table item_tag: foreign key item_tag_tag_fk
ALTER TABLE "item_tag" ADD CONSTRAINT "item_tag_tag_fk" FOREIGN KEY ("tag_id") REFERENCES "tag" ("id");

-- table audit: foreign key audit_emp_fk
ALTER TABLE "audit" ADD CONSTRAINT "audit_emp_fk" FOREIGN KEY ("emp_id") REFERENCES "emp" ("id");

-- table emp: index emp_name_ix: replace
CREATE INDEX "emp_name_ix" ON "emp" ("name");

-- table emp: index emp_salary_ix: replace
CREATE INDEX "emp_salary_ix" ON "emp" ("salary" DESC);

-- view v_emp: replace
CREATE OR REPLACE VIEW "v_emp" AS SELECT emp.id, emp.name FROM emp;

-- table emp: drop column old_flag (only in B)
ALTER TABLE "emp" DROP COLUMN "old_flag";

-- table old_log: only in B
DROP TABLE "old_log";
