import type { Dialect } from "./split";

const w = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Words that are keywords wherever they appear (never treated as column names). */
export const HARD_KEYWORDS = new Set(
  w(`select from where and or not null is in like between exists case when then else end as on join inner left right
  full outer cross natural using group by order having limit offset union all intersect except distinct insert into
  values update set delete create alter drop table index view database schema asc desc with true false by`),
);

const CORE = w(`
  select from where and or not null is in like between exists case when then else end as on join inner left right
  full outer cross natural using group by order having limit offset union all intersect except distinct insert into
  values update set delete create alter drop table index view database schema primary key foreign references unique
  check default constraint add column rename to asc desc with recursive returning true false cascade restrict if
  begin commit rollback transaction truncate explain analyze grant revoke fetch next first last only rows over
  partition window filter nulls lateral any some escape collate cast interval current_date current_time
  current_timestamp do nothing temporary temp trigger function procedure returns language declare savepoint
  release sequence materialized unbounded preceding following within generated always identity cube rollup
  grouping sets for of after before instead each execute deferrable initially deferred immediate isnull notnull
  similar overlaps concurrently inherits vacuum reindex show reset start abort checkpoint
`);

const PG = w(`
  ilike conflict unlogged serial bigserial smallserial tablespace verbose analyse authorization variadic
  copy stdin stdout
`);

const MYSQL = w(`
  ignore straight_join unsigned signed zerofill auto_increment engine charset describe use regexp rlike div xor
  modify low_priority high_priority delayed duplicate optimize flush
`);

const SQLITE = w(`
  pragma autoincrement glob indexed without rowid attach detach plan query fail raise strict
`);

/** Oracle SQL and PL/SQL. */
const ORACLE = w(`
  minus connect prior nocycle start rownum rowid sysdate systimestamp dual level merge matched pivot unpivot model sample
  synonym package body type cursor loop exception raise pragma constant subtype record bulk collect forall exit continue
  elsif elseif return out nocopy authid definer editionable noneditionable force nextval currval tablespace storage lob
  partition subpartition compress nocompress logging nologging parallel noparallel unlimited quota user role
  identified profile comment lock mode share nowait wait skip locked flashback versions scn purge recyclebin enable
  disable validate novalidate rely online rebuild invisible visible virtual public resource access audit noaudit
  increment initial maxextents minvalue maxvalue cache nocache order noorder cycle nocycle session uid whenever
  successful file offline mlslabel column_value nested_table_id immediate pls_integer binary_integer natural
  positive naturaln positiven simple_integer rowtype ref using out inout new old referencing while repeat
  case sqlcode sqlerrm no_data_found too_many_rows others dbms_output put_line wrapped deterministic pipelined
  result_cache parallel_enable aggregate external java call
`);

/**
 * Words an Oracle identifier must be quoted for: `V$RESERVED_WORDS where RESERVED = 'Y'` of 23ai plus the reserved
 * words of the SQL Language Reference that the view leaves out (ACCESS, COMMENT, LEVEL, ROWNUM, SYSDATE, USER ...).
 */
export const ORACLE_RESERVED = new Set(
  w(`
  access add all alter and any as asc audit between by char check cluster column column_value comment compress connect
  create current date decimal default delete desc distinct drop else exclusive exists file float for from grant group
  having identified immediate in increment index initial insert integer intersect into is level like lock long maxextents
  minus mlslabel mode modify nested_table_id noaudit nocompress not nowait null number of offline on online option or
  order pctfree prior public raw rename resource revoke row rowid rownum rows select session set share size smallint
  start successful synonym sysdate table then to trigger uid union unique update user validate values varchar varchar2
  view whenever where with except
`),
);

/** SQL data type names, colored as keywords where they sit in a type position. */
const TYPES = w(`
  int integer smallint bigint tinyint mediumint decimal numeric real float double precision boolean bool bit
  char character varchar nchar nvarchar text tinytext mediumtext longtext clob blob tinyblob mediumblob longblob
  binary varbinary bytea date time timestamp timestamptz timetz datetime year interval uuid json jsonb xml
  serial bigserial smallserial money inet cidr macaddr point line polygon circle box array enum set
  int2 int4 int8 float4 float8 varying
  number varchar2 nvarchar2 nclob long raw rowid urowid binary_float binary_double pls_integer binary_integer
  simple_integer boolean bfile
`);

/** Keywords that act as functions when followed by `(`. */
export const KEYWORD_FUNCTIONS = new Set(w("left right replace if insert mod user current_user session_user truncate"));

/** Words after which the next identifier names a table (not a function call, not a column). */
export const TABLE_INTRO = new Set(w("from join update into table truncate view index trigger exists only"));

export function keywordsFor(dialect: Dialect): Set<string> {
  const s = new Set(CORE);
  for (const x of dialect === "postgres" ? PG : dialect === "mysql" ? MYSQL : dialect === "oracle" ? ORACLE : SQLITE) s.add(x);
  if (dialect === "oracle") for (const x of ["ilike", "limit", "vacuum", "reindex", "concurrently", "inherits"]) s.delete(x);
  return s;
}

export const TYPE_NAMES = new Set(TYPES);

export interface FunctionInfo {
  name: string;
  /** Argument signature shown in the completion row, `(x numeric)`. */
  args: string;
  /** Return type shown at the right. */
  ret: string;
}

const f = (name: string, args: string, ret: string): FunctionInfo => ({ name, args, ret });

const COMMON_FUNCTIONS: FunctionInfo[] = [
  f("count", "*", "bigint"),
  f("sum", "x", "numeric"),
  f("avg", "x", "numeric"),
  f("min", "x", "any"),
  f("max", "x", "any"),
  f("abs", "x", "numeric"),
  f("round", "x, n", "numeric"),
  f("ceil", "x", "numeric"),
  f("floor", "x", "numeric"),
  f("power", "x, y", "double"),
  f("sqrt", "x", "double"),
  f("coalesce", "a, b", "any"),
  f("nullif", "a, b", "any"),
  f("greatest", "a, b", "any"),
  f("least", "a, b", "any"),
  f("length", "s", "integer"),
  f("lower", "s", "text"),
  f("upper", "s", "text"),
  f("trim", "s", "text"),
  f("ltrim", "s", "text"),
  f("rtrim", "s", "text"),
  f("substr", "s, from, len", "text"),
  f("substring", "s, from, len", "text"),
  f("replace", "s, from, to", "text"),
  f("concat", "a, b", "text"),
  f("left", "s, n", "text"),
  f("right", "s, n", "text"),
  f("cast", "x as type", "any"),
  f("row_number", "", "bigint"),
  f("rank", "", "bigint"),
  f("dense_rank", "", "bigint"),
  f("lag", "x, n", "any"),
  f("lead", "x, n", "any"),
  f("first_value", "x", "any"),
  f("last_value", "x", "any"),
  f("ntile", "n", "integer"),
];

const PG_FUNCTIONS: FunctionInfo[] = [
  f("now", "", "timestamptz"),
  f("current_setting", "name", "text"),
  f("date_trunc", "field, ts", "timestamp"),
  f("date_part", "field, ts", "double precision"),
  f("extract", "field from ts", "numeric"),
  f("age", "ts", "interval"),
  f("to_char", "x, fmt", "text"),
  f("to_date", "s, fmt", "date"),
  f("to_timestamp", "s, fmt", "timestamptz"),
  f("to_number", "s, fmt", "numeric"),
  f("string_agg", "x, sep", "text"),
  f("array_agg", "x", "anyarray"),
  f("json_agg", "x", "json"),
  f("jsonb_agg", "x", "jsonb"),
  f("jsonb_build_object", "k, v", "jsonb"),
  f("json_build_object", "k, v", "json"),
  f("jsonb_extract_path", "j, path", "jsonb"),
  f("generate_series", "start, stop", "setof"),
  f("unnest", "arr", "setof"),
  f("regexp_replace", "s, pat, rep", "text"),
  f("regexp_matches", "s, pat", "setof text[]"),
  f("split_part", "s, sep, n", "text"),
  f("position", "sub in s", "integer"),
  f("md5", "s", "text"),
  f("gen_random_uuid", "", "uuid"),
  f("nextval", "seq", "bigint"),
  f("currval", "seq", "bigint"),
  f("setval", "seq, n", "bigint"),
  f("pg_size_pretty", "n", "text"),
  f("pg_typeof", "x", "regtype"),
  f("random", "", "double precision"),
  f("bool_and", "x", "boolean"),
  f("bool_or", "x", "boolean"),
  f("exists", "subquery", "boolean"),
  f("char_length", "s", "integer"),
  f("initcap", "s", "text"),
  f("lpad", "s, n, fill", "text"),
  f("rpad", "s, n, fill", "text"),
  f("repeat", "s, n", "text"),
  f("reverse", "s", "text"),
  f("mod", "x, y", "numeric"),
];

const MYSQL_FUNCTIONS: FunctionInfo[] = [
  f("now", "", "datetime"),
  f("curdate", "", "date"),
  f("curtime", "", "time"),
  f("date_format", "d, fmt", "varchar"),
  f("str_to_date", "s, fmt", "datetime"),
  f("date_add", "d, interval", "datetime"),
  f("date_sub", "d, interval", "datetime"),
  f("datediff", "a, b", "int"),
  f("timestampdiff", "unit, a, b", "bigint"),
  f("ifnull", "a, b", "any"),
  f("if", "cond, a, b", "any"),
  f("concat_ws", "sep, a, b", "varchar"),
  f("group_concat", "x", "text"),
  f("json_extract", "doc, path", "json"),
  f("json_object", "k, v", "json"),
  f("json_arrayagg", "x", "json"),
  f("char_length", "s", "int"),
  f("lpad", "s, n, fill", "varchar"),
  f("rpad", "s, n, fill", "varchar"),
  f("locate", "sub, s", "int"),
  f("find_in_set", "s, list", "int"),
  f("last_insert_id", "", "bigint"),
  f("uuid", "", "char"),
  f("rand", "", "double"),
  f("mod", "x, y", "numeric"),
  f("year", "d", "int"),
  f("month", "d", "int"),
  f("day", "d", "int"),
  f("database", "", "varchar"),
  f("version", "", "varchar"),
];

const SQLITE_FUNCTIONS: FunctionInfo[] = [
  f("datetime", "t, mod", "text"),
  f("date", "t, mod", "text"),
  f("time", "t, mod", "text"),
  f("strftime", "fmt, t", "text"),
  f("julianday", "t", "real"),
  f("ifnull", "a, b", "any"),
  f("iif", "cond, a, b", "any"),
  f("group_concat", "x, sep", "text"),
  f("instr", "s, sub", "integer"),
  f("typeof", "x", "text"),
  f("random", "", "integer"),
  f("randomblob", "n", "blob"),
  f("hex", "x", "text"),
  f("quote", "x", "text"),
  f("total", "x", "real"),
  f("printf", "fmt, args", "text"),
  f("json_extract", "doc, path", "any"),
  f("json_object", "k, v", "text"),
  f("changes", "", "integer"),
  f("last_insert_rowid", "", "integer"),
  f("sqlite_version", "", "text"),
  f("char", "code", "text"),
  f("unicode", "s", "integer"),
];

const ORACLE_FUNCTIONS: FunctionInfo[] = [
  f("nvl", "a, b", "any"),
  f("nvl2", "x, a, b", "any"),
  f("decode", "x, search, result, default", "any"),
  f("to_char", "x, fmt", "varchar2"),
  f("to_date", "s, fmt", "date"),
  f("to_number", "s, fmt", "number"),
  f("to_timestamp", "s, fmt", "timestamp"),
  f("to_timestamp_tz", "s, fmt", "timestamp with time zone"),
  f("to_clob", "x", "clob"),
  f("to_nchar", "x", "nvarchar2"),
  f("to_yminterval", "s", "interval year to month"),
  f("to_dsinterval", "s", "interval day to second"),
  f("trunc", "x, fmt", "date"),
  f("add_months", "d, n", "date"),
  f("months_between", "a, b", "number"),
  f("last_day", "d", "date"),
  f("next_day", "d, weekday", "date"),
  f("sysdate", "", "date"),
  f("systimestamp", "", "timestamp with time zone"),
  f("current_date", "", "date"),
  f("current_timestamp", "", "timestamp with time zone"),
  f("localtimestamp", "", "timestamp"),
  f("extract", "field from x", "number"),
  f("instr", "s, sub, pos, n", "number"),
  f("substr", "s, pos, len", "varchar2"),
  f("lpad", "s, n, fill", "varchar2"),
  f("rpad", "s, n, fill", "varchar2"),
  f("initcap", "s", "varchar2"),
  f("translate", "s, from, to", "varchar2"),
  f("regexp_like", "s, pattern", "boolean"),
  f("regexp_substr", "s, pattern", "varchar2"),
  f("regexp_replace", "s, pattern, rep", "varchar2"),
  f("regexp_instr", "s, pattern", "number"),
  f("listagg", "x, sep", "varchar2"),
  f("rawtohex", "r", "varchar2"),
  f("hextoraw", "s", "raw"),
  f("sys_guid", "", "raw"),
  f("user", "", "varchar2"),
  f("sys_context", "namespace, param", "varchar2"),
  f("mod", "x, y", "number"),
  f("remainder", "x, y", "number"),
  f("lengthb", "s", "number"),
  f("dump", "x", "varchar2"),
  f("ascii", "s", "number"),
  f("chr", "n", "varchar2"),
  f("json_value", "doc, path", "varchar2"),
  f("json_query", "doc, path", "varchar2"),
  f("json_object", "k value v", "json"),
  f("json_arrayagg", "x", "json"),
  f("xmlagg", "x", "xmltype"),
  f("cardinality", "nested", "number"),
  f("ratio_to_report", "x", "number"),
  f("percentile_cont", "p", "number"),
  f("stddev", "x", "number"),
  f("variance", "x", "number"),
  f("bitand", "a, b", "number"),
];

/** Names that PostgreSQL / MySQL have in the shared list but Oracle does not. */
const NOT_ORACLE = new Set(["left", "right", "substring", "concat_ws", "if"]);

export function functionsFor(dialect: Dialect): FunctionInfo[] {
  const extra = dialect === "postgres" ? PG_FUNCTIONS : dialect === "mysql" ? MYSQL_FUNCTIONS : dialect === "oracle" ? ORACLE_FUNCTIONS : SQLITE_FUNCTIONS;
  const seen = new Set(extra.map((x) => x.name));
  return [...extra, ...COMMON_FUNCTIONS.filter((x) => !seen.has(x.name) && !(dialect === "oracle" && NOT_ORACLE.has(x.name)))];
}

/** Keyword completion entries with an example snippet, like DataGrip's `cast  CAST('foo' as JSON)` row. */
export const KEYWORD_HINTS: Record<string, string> = {
  cast: "CAST('foo' as JSON)",
  case: "CASE WHEN .. THEN .. END",
  exists: "EXISTS (subquery)",
  between: "BETWEEN a AND b",
  group: "GROUP BY",
  order: "ORDER BY",
  union: "UNION [ALL]",
  limit: "LIMIT n",
  insert: "INSERT INTO",
  delete: "DELETE FROM",
  returning: "RETURNING cols",
};
