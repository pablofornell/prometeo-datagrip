-- Schema B of the migration fixtures (MySQL, database cmpx_b): it differs from A on purpose.
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (mysql).
create table dept (
  id int not null,
  name varchar(40),
  primary key (id)
) engine = innodb;

create table emp (
  id int not null,
  name varchar(50),
  code varchar(10) not null,
  salary decimal(10,2) default 1,
  old_flag tinyint,
  dept_id int,
  primary key (id),
  constraint emp_salary_ck check (salary > 0),
  constraint emp_dept_fk foreign key (dept_id) references dept (id) on delete cascade,
  unique index emp_name_ix (name),
  index emp_dept_ix (dept_id),
  index emp_old_ix (code)
) engine = innodb;

create table orders (
  id int not null,
  ref varchar(20) not null,
  primary key (id)
) engine = innodb;

create table order_lines (
  id int not null,
  order_id int not null,
  qty int,
  primary key (id),
  constraint order_lines_order_fk foreign key (order_id) references orders (id)
) engine = innodb;

create table note (
  id int not null,
  code varchar(10),
  primary key (id),
  unique (code)
) engine = innodb;

create view v_emp as select id from emp;

create table old_log (
  id int not null,
  primary key (id)
) engine = innodb;
