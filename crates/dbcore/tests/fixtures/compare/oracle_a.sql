-- Schema A of the migration fixtures (Oracle, owner DEMO). Every object has the prefix CMPX_: the test drops them first.
-- The objects match the model in src/features/schema-diff/fixtures.test.ts (oracle).
create table CMPX_DEPT (
  ID number(10) not null,
  NAME varchar2(40),
  constraint CMPX_DEPT_PK primary key (ID),
  constraint CMPX_DEPT_NAME_UQ unique (NAME)
);

create table CMPX_EMP (
  ID number(10) not null,
  NAME varchar2(80) not null,
  CODE varchar2(10),
  SALARY number(10,2) default 0,
  STATUS varchar2(10) default 'new' not null,
  DEPT_ID number(10),
  constraint CMPX_EMP_PK primary key (ID),
  constraint CMPX_EMP_SALARY_CK check (SALARY >= 0),
  constraint CMPX_EMP_DEPT_FK foreign key (DEPT_ID) references CMPX_DEPT (ID) on delete cascade,
  constraint CMPX_EMP_CODE_UQ unique (CODE)
);
create index CMPX_EMP_NAME_IX on CMPX_EMP (NAME);
create index CMPX_EMP_SAL_IX on CMPX_EMP (SALARY desc);
create bitmap index CMPX_EMP_STATUS_BX on CMPX_EMP (STATUS);

create table CMPX_ORDERS (
  ID number(10) not null,
  REF varchar2(20),
  constraint CMPX_ORDERS_PK primary key (ID)
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

create or replace view CMPX_V_EMP as select ID, NAME from CMPX_EMP;

create table CMPX_TAG (
  ID number(10) not null,
  NAME varchar2(20),
  constraint CMPX_TAG_PK primary key (ID)
);
create index CMPX_TAG_NAME_IX on CMPX_TAG (NAME);

create table CMPX_ITEM_TAG (
  ITEM_ID number(10) not null,
  TAG_ID number(10) not null,
  constraint CMPX_ITEM_TAG_PK primary key (ITEM_ID, TAG_ID),
  constraint CMPX_ITEM_TAG_TAG_FK foreign key (TAG_ID) references CMPX_TAG (ID)
);

create table CMPX_AUDIT (
  ID number(10) not null,
  EMP_ID number(10) not null,
  constraint CMPX_AUDIT_PK primary key (ID),
  constraint CMPX_AUDIT_EMP_FK foreign key (EMP_ID) references CMPX_EMP (ID)
);
