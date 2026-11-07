/** DDL of the small objects of New >: view, materialized view, sequence, schema (and Modify Schema on PostgreSQL). */
import type { Driver } from "./model";
import { type Plan, ident, literal, qualified } from "./sqlgen";

export type ObjectKind = "view" | "materializedView" | "sequence" | "schema";

export interface ObjectDef {
  kind: ObjectKind;
  /** Schema the object goes into (empty for a schema). */
  schema: string;
  name: string;
  comment: string;
  /** Query of a view. */
  query: string;
  start: string;
  increment: string;
  minValue: string;
  maxValue: string;
  cycle: boolean;
}

export function newObject(kind: ObjectKind, schema: string, driver: Driver): ObjectDef {
  const name = { view: "view_name", materializedView: "view_name", sequence: "sequence_name", schema: driver === "mysql" ? "database_name" : "schema_name" }[kind];
  return { kind, schema: kind === "schema" ? "" : schema, name, comment: "", query: "", start: "", increment: "", minValue: "", maxValue: "", cycle: false };
}

export const OBJECT_TITLE: Record<ObjectKind, (d: Driver) => string> = {
  view: () => "View",
  materializedView: () => "Materialized View",
  sequence: () => "Sequence",
  schema: (d) => (d === "mysql" ? "Database" : "Schema"),
};

const plan = (statements: string[], d: Driver): Plan => ({ pre: [], statements, post: [], transactional: d !== "mysql", warnings: [] });

export function validateObject(o: ObjectDef): string[] {
  const out: string[] = [];
  if (!o.name.trim()) out.push("The name is empty");
  if ((o.kind === "view" || o.kind === "materializedView") && !o.query.trim()) out.push("The query is empty");
  for (const [label, v] of [["Start", o.start], ["Increment", o.increment], ["Min", o.minValue], ["Max", o.maxValue]] as const)
    if (v.trim() && !/^-?\d+$/.test(v.trim())) out.push(`${label} must be an integer`);
  return out;
}

export function createObjectPlan(d: Driver, o: ObjectDef): Plan {
  const name = o.kind === "schema" ? ident(d, o.name) : qualified(d, o.schema, o.name);
  const st: string[] = [];
  switch (o.kind) {
    case "view":
      st.push(`create view ${name} as\n${o.query.trim().replace(/;\s*$/, "")};`);
      if (d === "postgres" && o.comment) st.push(`comment on view ${name} is ${literal(d, o.comment)};`);
      break;
    case "materializedView":
      st.push(`create materialized view ${name} as\n${o.query.trim().replace(/;\s*$/, "")};`);
      if (o.comment) st.push(`comment on materialized view ${name} is ${literal(d, o.comment)};`);
      break;
    case "sequence": {
      const parts = [`create sequence ${name}`];
      if (o.increment.trim()) parts.push(`    increment by ${o.increment.trim()}`);
      if (o.minValue.trim()) parts.push(`    minvalue ${o.minValue.trim()}`);
      if (o.maxValue.trim()) parts.push(`    maxvalue ${o.maxValue.trim()}`);
      if (o.start.trim()) parts.push(`    start with ${o.start.trim()}`);
      if (o.cycle) parts.push("    cycle");
      st.push(parts.join("\n") + ";");
      if (o.comment) st.push(`comment on sequence ${name} is ${literal(d, o.comment)};`);
      break;
    }
    case "schema":
      st.push(d === "mysql" ? `create database ${name};` : `create schema ${name};`);
      if (d === "postgres" && o.comment) st.push(`comment on schema ${name} is ${literal(d, o.comment)};`);
      break;
  }
  return plan(st, d);
}

/** Modify Schema (PostgreSQL): rename and comment. */
export function alterSchemaPlan(d: Driver, orig: ObjectDef, cur: ObjectDef): Plan {
  const st: string[] = [];
  let name = ident(d, orig.name);
  if (orig.name !== cur.name) {
    st.push(`alter schema ${name} rename to ${ident(d, cur.name)};`);
    name = ident(d, cur.name);
  }
  if (orig.comment !== cur.comment) st.push(`comment on schema ${name} is ${cur.comment ? literal(d, cur.comment) : "null"};`);
  return plan(st, d);
}
