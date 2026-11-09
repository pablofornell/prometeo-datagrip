-- Schema B of the migration fixtures (PostgreSQL, schema cmpx_b): it differs from A on purpose.
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (postgres).
create table dept (
  id integer not null,
  name varchar(40),
  constraint dept_pkey primary key (id)
);

create table emp (
  id integer not null,
  name varchar(50),
  code varchar(10) not null,
  salary numeric(10,2) default 1,
  old_flag integer,
  dept_id integer,
  constraint emp_pkey primary key (id),
  constraint emp_salary_ck check (salary > 0),
  constraint emp_dept_fk foreign key (dept_id) references dept (id) on delete cascade
);
create unique index emp_name_ix on emp (name);
create index emp_salary_ix on emp (salary);
create index emp_old_ix on emp (dept_id);

-- the primary key of A is orders_pkey: here it has another name, so it is replaced
create table orders (
  id integer not null,
  ref varchar(20),
  constraint orders_pkey_old primary key (id)
);

create table order_lines (
  id integer not null,
  order_id integer not null,
  qty numeric(5),
  constraint order_lines_pkey primary key (id),
  constraint order_lines_order_fk foreign key (order_id) references orders (id)
);

-- unnamed primary key and unique: PostgreSQL names them note_pkey and note_code_key
create table note (
  id integer not null primary key,
  code varchar(10) unique
);

create view v_emp as select id from emp;

create table old_log (
  id integer not null,
  constraint old_log_pkey primary key (id)
);
