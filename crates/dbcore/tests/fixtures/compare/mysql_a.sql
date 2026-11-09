-- Schema A of the migration fixtures (MySQL, database cmpx_a; the test runs it with that database).
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (mysql).
create table dept (
  id int not null,
  name varchar(40),
  primary key (id),
  constraint dept_name_key unique (name)
) engine = innodb;

create table emp (
  id int not null,
  name varchar(80) not null,
  code varchar(10),
  salary decimal(10,2) default 0,
  status varchar(10) not null default 'new',
  dept_id int,
  primary key (id),
  constraint emp_salary_ck check (salary >= 0),
  constraint emp_dept_fk foreign key (dept_id) references dept (id) on delete cascade,
  constraint emp_code_key unique (code),
  index emp_name_ix (name),
  index emp_dept_ix (dept_id)
) engine = innodb;

-- the key is on (id, ref); the foreign key refers to (id), which needs a unique key of its own
create table orders (
  id int not null,
  ref varchar(20) not null,
  primary key (id, ref),
  constraint orders_id_uq unique (id)
) engine = innodb;

create table order_lines (
  id int not null,
  order_id int not null,
  qty int,
  primary key (id),
  constraint order_lines_order_fk foreign key (order_id) references orders (id)
) engine = innodb;

-- unnamed unique: MySQL names it after its column (code)
create table note (
  id int not null,
  code varchar(10),
  primary key (id),
  unique (code)
) engine = innodb;

create view v_emp as select id, name from emp;

create table tag (
  id int not null,
  name varchar(20),
  primary key (id),
  index tag_name_ix (name)
) engine = innodb;

create table item_tag (
  item_id int not null,
  tag_id int not null,
  primary key (item_id, tag_id),
  constraint item_tag_tag_fk foreign key (tag_id) references tag (id)
) engine = innodb;

create table audit (
  id int not null,
  emp_id int not null,
  primary key (id),
  constraint audit_emp_fk foreign key (emp_id) references emp (id)
) engine = innodb;
