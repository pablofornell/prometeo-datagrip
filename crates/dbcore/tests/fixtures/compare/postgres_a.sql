-- Schema A of the migration fixtures (PostgreSQL, schema cmpx_a; the test runs it with that search path).
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (postgres).
create table dept (
  id integer not null,
  name varchar(40),
  constraint dept_pkey primary key (id),
  constraint dept_name_key unique (name)
);

create table emp (
  id integer not null,
  name varchar(80) not null,
  code varchar(10),
  salary numeric(10,2) default 0,
  status varchar(10) default 'new' not null,
  dept_id integer,
  constraint emp_pkey primary key (id),
  constraint emp_salary_ck check (salary >= 0),
  constraint emp_dept_fk foreign key (dept_id) references dept (id) on delete cascade,
  constraint emp_code_key unique (code)
);
create index emp_name_ix on emp (name);
create index emp_salary_ix on emp (salary desc);

create table orders (
  id integer not null,
  ref varchar(20),
  constraint orders_pkey primary key (id)
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

create view v_emp as select id, name from emp;

create table tag (
  id integer not null,
  name varchar(20),
  constraint tag_pkey primary key (id)
);
create index tag_name_ix on tag (name);

create table item_tag (
  item_id integer not null,
  tag_id integer not null,
  constraint item_tag_pkey primary key (item_id, tag_id),
  constraint item_tag_tag_fk foreign key (tag_id) references tag (id)
);

create table audit (
  id integer not null,
  emp_id integer not null,
  constraint audit_pkey primary key (id),
  constraint audit_emp_fk foreign key (emp_id) references emp (id)
);
