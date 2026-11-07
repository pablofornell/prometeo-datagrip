// @vitest-environment node
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { aliasFor, bulbAt, bulbField, closest, editDistance, intentionHostFacet, intentionsAt } from "./intentions";
import { SchemaIndex } from "./schemaIndex";
import { configField, problemsField, setConfig, setProblems } from "./state";
import type { SchemaSnapshot } from "./types";
import { computeProblems } from "./inspect";

const schema: SchemaSnapshot = {
  schemas: [
    {
      name: "main",
      tables: [
        { name: "products", kind: "table", columns: [{ name: "id", type: "INTEGER", key: "pk" }, { name: "name", type: "TEXT" }, { name: "price", type: "REAL" }, { name: "category_id", type: "INTEGER" }] },
        { name: "categories", kind: "table", columns: [{ name: "id", type: "INTEGER", key: "pk" }, { name: "title", type: "TEXT" }] },
      ],
    },
  ],
};
const index = new SchemaIndex(schema, "main");

function stateOf(sql: string, head = 0): EditorState {
  const st = EditorState.create({ doc: sql, selection: { anchor: head }, extensions: [configField, problemsField, bulbField, intentionHostFacet.of({ refreshSchema: () => {} })] });
  const s = st.update({ effects: setConfig.of({ dialect: "sqlite", index, statementFrame: true }) }).state;
  return s.update({ effects: setProblems.of(computeProblems(s)) }).state;
}
const at = (sql: string, marker: string): string[] => intentionsAt(stateOf(sql), sql.indexOf(marker) + 1, { host: { refreshSchema: () => {} } }).map((i) => i.label);
const apply = (sql: string, marker: string, id: string): string => {
  const st = stateOf(sql);
  const it = intentionsAt(st, sql.indexOf(marker) + 1, { host: { refreshSchema: () => {} } }).find((i) => i.id === id);
  if (!it) throw new Error(`no intention ${id}`);
  let doc = sql;
  const view = {
    state: st,
    dispatch: (spec: { changes: { from: number; to?: number; insert: string } }) => {
      const c = spec.changes;
      doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to ?? c.from);
    },
    coordsAtPos: () => null,
  };
  it.apply(view as never);
  return doc;
};

describe("edit distance", () => {
  it("measures and gives up", () => {
    expect(editDistance("colour", "color")).toBe(1);
    expect(editDistance("abc", "abcdefg")).toBe(3);
    expect(closest("prodcuts", ["products", "categories", "prodcuts"])).toEqual(["products"]);
  });
  it("builds aliases", () => {
    expect(aliasFor("order_items", new Set())).toBe("oi");
    expect(aliasFor("products", new Set(["p"]))).toBe("p2");
  });
});

describe("intentions", () => {
  it("offers a rename and a create table for an unknown table", () => {
    expect(at("select * from prodcuts;", "prodcuts")).toEqual(["Refresh schema", "Change to 'products'", "Create table 'prodcuts'", "Quote identifier"]);
    expect(apply("select * from prodcuts;", "prodcuts", "change:products")).toBe("select * from products;");
    expect(apply("select * from prodcuts;", "prodcuts", "create-table")).toBe("create table prodcuts\n(\n    id integer primary key\n);\n\nselect * from prodcuts;");
  });

  it("offers a rename and add column for an unknown column", () => {
    expect(at("select nam from products;", "nam")).toEqual(["Refresh schema", "Change to 'name'", "Add column 'nam' to 'products' table", "Quote identifier"]);
    expect(apply("select colour from products;", "colour", "add-column:products")).toBe("alter table products add colour text;\n\nselect colour from products;");
  });

  it("expands the star", () => {
    expect(apply("select * from categories;", "*", "expand-star")).toBe("select id, title from categories;");
    expect(apply("select * from products p join categories c on c.id = p.category_id;", "*", "expand-star")).toBe(
      "select p.id, p.name, p.price, p.category_id, c.id, c.title from products p join categories c on c.id = p.category_id;",
    );
    expect(apply("select c.* from products p join categories c on c.id = p.category_id;", "*", "expand-star")).toBe("select c.id, c.title from products p join categories c on c.id = p.category_id;");
    expect(at("select count(*) from categories;", "*")).not.toContain("Expand column list");
  });

  it("quotes and unquotes", () => {
    expect(apply("select name from products;", "name", "quote")).toBe('select "name" from products;');
    expect(apply('select "name" from products;', "name", "unquote")).toBe("select name from products;");
    expect(at('select "Name" from products;', "Name")).not.toContain("Unquote identifier");
  });

  it("qualifies a column and adds an alias", () => {
    expect(apply("select title from products join categories on 1=1;", "title", "qualify")).toBe("select categories.title from products join categories on 1=1;");
    expect(apply("select * from categories;", "categories", "add-alias")).toBe("select * from categories c;");
    expect(at("select * from categories c;", "categories")).not.toContain("Add alias 'c'");
    expect(at("select categories.id from categories;", "categories;")).not.toContain("Add alias 'c'");
  });

  it("offers nothing on keywords and read-only editors", () => {
    expect(at("select 1;", "select")).toEqual([]);
    const ro = EditorState.create({ doc: "select * from prodcuts;", extensions: [configField, EditorState.readOnly.of(true)] });
    expect(intentionsAt(ro, 18)).toEqual([]);
  });

  it("colors the bulb by the problem under the caret", () => {
    const sql = "select * from prodcuts;";
    expect(bulbAt(stateOf(sql, sql.indexOf("prodcuts") + 2))).toBe("error");
    expect(bulbAt(stateOf("select name from products;", 9))).toBe("bulb");
    expect(bulbAt(stateOf("select 1;", 2))).toBe("none");
  });
});
