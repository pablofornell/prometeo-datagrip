// @vitest-environment node
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { completionSource } from "./complete";
import { SchemaIndex } from "./schemaIndex";
import type { Dialect } from "./split";
import { configField, setConfig } from "./state";
import { templateListField } from "./templates";
import type { SchemaSnapshot } from "./types";

const schema: SchemaSnapshot = {
  schemas: [
    {
      name: "public",
      tables: [
        {
          name: "offices",
          kind: "table",
          columns: [{ name: "id", type: "INTEGER", key: "pk" }],
        },
        {
          name: "orders",
          kind: "table",
          columns: [
            { name: "id", type: "INTEGER", key: "pk" },
            { name: "customer_id", type: "INTEGER", key: "fk" },
          ],
          foreignKeys: [{ name: "orders_customer_id_fkey", columns: ["customer_id"], refSchema: "public", refTable: "customers", refColumns: ["id"] }],
        },
        {
          name: "customers",
          kind: "table",
          columns: [{ name: "id", type: "INTEGER", key: "pk" }],
        },
        {
          name: "parent",
          kind: "table",
          columns: [
            { name: "x", type: "INTEGER", key: "pk" },
            { name: "y", type: "INTEGER", key: "pk" },
          ],
        },
        {
          name: "child",
          kind: "table",
          columns: [
            { name: "a", type: "INTEGER", key: "fk" },
            { name: "b", type: "INTEGER", key: "fk" },
          ],
          foreignKeys: [{ name: "child_parent_fkey", columns: ["a", "b"], refSchema: "public", refTable: "parent", refColumns: ["x", "y"] }],
        },
      ],
    },
  ],
};

interface Ctx {
  dialect?: Dialect;
  keywordCase?: "keep" | "upper" | "lower";
  insertTableAlias?: boolean;
  explicit?: boolean;
}

function complete(sql: string, pos: number, opts: Ctx = {}): CompletionResult | null {
  const state = EditorState.create({ doc: sql, selection: { anchor: pos }, extensions: [configField, templateListField] });
  const index = new SchemaIndex(schema, "public");
  const st = state.update({
    effects: setConfig.of({
      dialect: opts.dialect ?? "postgres",
      index,
      keywordCase: opts.keywordCase,
      insertTableAlias: opts.insertTableAlias,
      statementFrame: true,
    }),
  }).state;
  const ctx = {
    state: st,
    pos,
    explicit: opts.explicit ?? false,
    // compute the trailing word run ending at `pos`, like CodeMirror's matchBefore does
    matchBefore: () => {
      let from = pos;
      const re = /[\p{L}\p{N}_$]/u;
      while (from > 0 && re.test(st.doc.sliceString(from - 1, from))) from--;
      return { from, to: pos, text: st.doc.sliceString(from, pos) };
    },
  } as unknown as CompletionContext;
  return completionSource(ctx);
}

const applyOf = (o: Completion): string => (typeof o.apply === "string" ? o.apply : "");

describe("completion source", () => {
  it("opens the popup on an empty prefix after FROM but not after SELECT", () => {
    expect(complete("select * from ", 14)).not.toBeNull();
    expect(complete("select ", 7)).toBeNull();
  });

  it("applies the keyword case setting to keyword rows", () => {
    const sql = "select * from orders o w";
    const upper = complete(sql, sql.length, { keywordCase: "upper" })!;
    expect(upper.options.some((o) => o.type === "keyword" && o.label === "SELECT")).toBe(true);
    expect(upper.options.some((o) => o.type === "keyword" && o.label === "select")).toBe(false);
    const lower = complete(sql, sql.length, { keywordCase: "lower" })!;
    expect(lower.options.some((o) => o.type === "keyword" && o.label === "select")).toBe(true);
    expect(lower.options.some((o) => o.type === "keyword" && o.label === "SELECT")).toBe(false);
  });

  it("inserts an alias for a table in a FROM list", () => {
    const r = complete("select * from ", 14)!;
    const orders = r.options.find((o) => o.label === "orders");
    expect(orders).toBeDefined();
    expect(applyOf(orders!)).toBe("orders o");
  });

  it("completes the JOIN ... ON condition from a foreign key", () => {
    const r = complete("select * from orders o join ", 28)!;
    const customers = r.options.find((o) => o.label === "customers");
    expect(customers).toBeDefined();
    expect(applyOf(customers!)).toBe("customers c on c.id = o.customer_id");
  });

  it("does not insert an alias when the setting is off", () => {
    const r = complete("select * from ", 14, { insertTableAlias: false })!;
    const orders = r.options.find((o) => o.label === "orders");
    expect(orders).toBeDefined();
    expect(applyOf(orders!)).toBe("orders");
  });

  it("does not over-uniquify an alias against other tables in the list", () => {
    // `offices` and `orders` would both abbreviate to `o`, but the statement uses neither yet
    const r = complete("select * from ", 14)!;
    const orders = r.options.find((o) => o.label === "orders");
    expect(applyOf(orders!)).toBe("orders o");
  });

  it("inserts an alias after UPDATE and DELETE FROM but never after INTO", () => {
    expect(applyOf(complete("update ", 7)!.options.find((o) => o.label === "customers")!)).toBe("customers c");
    expect(applyOf(complete("delete from ", 12)!.options.find((o) => o.label === "customers")!)).toBe("customers c");
    expect(applyOf(complete("insert into ", 12)!.options.find((o) => o.label === "customers")!)).toBe("customers");
  });

  it("inserts an alias for the second table of a FROM list after a comma", () => {
    const r = complete("select * from orders o, ", 24, { explicit: true })!;
    const customers = r.options.find((o) => o.label === "customers");
    expect(applyOf(customers!)).toBe("customers c");
  });

  it("completes a composite foreign key into one AND-joined ON condition", () => {
    const r = complete("select * from child c join ", 27)!;
    const parent = r.options.find((o) => o.label === "parent");
    expect(applyOf(parent!)).toBe("parent p on p.x = c.a AND p.y = c.b");
  });

  it("takes the ON condition from any earlier table, nearest first", () => {
    // nearest earlier table `customers` has no FK to `parent`; the FK of `child` still yields the ON
    const r = complete("select * from child c, customers k join ", 40)!;
    const parent = r.options.find((o) => o.label === "parent");
    expect(applyOf(parent!)).toBe("parent p on p.x = c.a AND p.y = c.b");
  });
});
