-- Schema B of the migration fixtures (Oracle, owner DEMO): it differs from A on purpose.
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (oracle).
create table CMPX_DEPT (
  ID number(10) not null,
  NAME varchar2(40),
  constraint CMPX_DEPT_PK primary key (ID)
);

create table CMPX_EMP (
  ID number(10) not null,
  NAME varchar2(50),
  CODE varchar2(10) not null,
  SALARY number(10,2) default 1,
  OLD_FLAG number(1),
  DEPT_ID number(10),
  constraint CMPX_EMP_PK primary key (ID),
  constraint CMPX_EMP_SALARY_CK check (SALARY > 0),
  constraint CMPX_EMP_DEPT_FK foreign key (DEPT_ID) references CMPX_DEPT (ID) on delete cascade
);
create unique index CMPX_EMP_NAME_IX on CMPX_EMP (NAME);
create index CMPX_EMP_SAL_IX on CMPX_EMP (SALARY);
create index CMPX_EMP_OLD_IX on CMPX_EMP (DEPT_ID);

-- the primary key of A is CMPX_ORDERS_PK: here it has another name, so it is replaced
create table CMPX_ORDERS (
  ID number(10) not null,
  REF varchar2(20),
  constraint CMPX_ORDERS_PK_OLD primary key (ID)
);

create table CMPX_ORDER_LINES (
  ID number(10) not null,
  ORDER_ID number(10) not null,
  QTY number(5),
  constraint CMPX_LINES_PK primary key (ID),
  constraint CMPX_LINES_ORDER_FK foreign key (ORDER_ID) references CMPX_ORDERS (ID)
);

-- unnamed key and unique: the database names them (SYS_C...), the model matches them by definition
create table CMPX_NOTE (
  ID number(10) not null,
  CODE varchar2(10) unique,
  primary key (ID)
);

create or replace view CMPX_V_EMP as select ID from CMPX_EMP;

create table CMPX_OLD_LOG (
  ID number(10) not null,
  constraint CMPX_OLD_LOG_PK primary key (ID)
);
