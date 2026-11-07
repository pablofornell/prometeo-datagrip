/**
 * Keywords that an identifier must not be written as without quotes, per dialect (the lists of the servers).
 * PostgreSQL: the keywords that are not "unreserved" (`pg_get_keywords()` categories R, T, C -- what pg_dump quotes).
 * MySQL: the reserved words of 8.0 / 8.4 (`information_schema.KEYWORDS where RESERVED`).
 * SQLite: the complete keyword list of the language (https://sqlite.org/lang_keywords.html); many of them also work as
 * names, quoting them is always safe.
 */
import type { Driver } from "./model";

/** PostgreSQL 16. */
const POSTGRES =
  "all analyse analyze and any array as asc asymmetric authorization between bigint binary bit boolean both case " +
  "cast char character check coalesce collate collation column concurrently constraint create cross " +
  "current_catalog current_date current_role current_schema current_time current_timestamp current_user dec " +
  "decimal default deferrable desc distinct do else end except exists extract false fetch float for foreign " +
  "freeze from full grant greatest group grouping having ilike in initially inner inout int integer intersect " +
  "interval into is isnull join json_array json_arrayagg json_object json_objectagg lateral leading least left " +
  "like limit localtime localtimestamp national natural nchar none normalize not notnull null nullif numeric " +
  "offset on only or order out outer overlaps overlay placing position precision primary real references " +
  "returning right row select session_user setof similar smallint some substring symmetric system_user table " +
  "tablesample then time timestamp to trailing treat trim true union unique user using values varchar variadic " +
  "verbose when where window with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse " +
  "xmlpi xmlroot xmlserialize xmltable";

/** MySQL 8.4 plus the words 8.0 reserved that 8.4 dropped. */
const MYSQL =
  "accessible add all alter analyze and as asc asensitive before between bigint binary blob both by call cascade " +
  "case change char character check collate column condition constraint continue convert create cross cube " +
  "cume_dist current_date current_time current_timestamp current_user cursor database databases day_hour " +
  "day_microsecond day_minute day_second dec decimal declare default delayed delete dense_rank desc describe " +
  "deterministic distinct distinctrow div double drop dual each else elseif empty enclosed escaped except exists " +
  "exit explain false fetch first_value float float4 float8 for force foreign from fulltext function generated " +
  "get get_master_public_key grant group grouping groups having high_priority hour_microsecond hour_minute " +
  "hour_second if ignore in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer " +
  "intersect interval into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value " +
  "lateral lead leading leave left like limit linear lines load localtime localtimestamp lock long longblob " +
  "longtext loop low_priority master_bind master_ssl_verify_server_cert match maxvalue mediumblob mediumint " +
  "mediumtext middleint minute_microsecond minute_second mod modifies natural no_write_to_binlog not nth_value " +
  "ntile null numeric of on optimize optimizer_costs option optionally or order out outer outfile over partition " +
  "percent_rank precision primary procedure purge qualify range rank read read_write reads real recursive " +
  "references regexp release rename repeat replace require resignal restrict return revoke right rlike row " +
  "row_number rows schema schemas second_microsecond select sensitive separator set show signal smallint spatial " +
  "specific sql sql_big_result sql_calc_found_rows sql_small_result sqlexception sqlstate sqlwarning ssl starting " +
  "stored straight_join system table tablesample terminated then tinyblob tinyint tinytext to trailing trigger " +
  "true undo union unique unlock unsigned update usage use using utc_date utc_time utc_timestamp values varbinary " +
  "varchar varcharacter varying virtual when where while window with write xor year_month zerofill";

/** SQLite 3.4x. */
const SQLITE =
  "abort action add after all alter always analyze and as asc attach autoincrement before begin between by " +
  "cascade case cast check collate column commit conflict constraint create cross current current_date " +
  "current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each " +
  "else end escape except exclude exclusive exists explain fail filter first following for foreign from full " +
  "generated glob group groups having if ignore immediate in index indexed initially inner insert instead " +
  "intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null " +
  "nulls of offset on or order others outer over partition plan pragma preceding primary query raise range " +
  "recursive references regexp reindex release rename replace restrict returning right rollback row rows " +
  "savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using " +
  "vacuum values view virtual when where window with without";

const SETS: Record<Driver, Set<string>> = {
  postgres: new Set(POSTGRES.split(" ")),
  mysql: new Set(MYSQL.split(" ")),
  sqlite: new Set(SQLITE.split(" ")),
};

/** Whether `name` (lower case) is a keyword of the dialect that needs quotes as an identifier. */
export const isKeyword = (d: Driver, name: string): boolean => SETS[d].has(name.toLowerCase());
