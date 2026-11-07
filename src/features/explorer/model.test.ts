import { describe, expect, it } from "vitest";
import type { TreeNode } from "../../api/db";
import { commentOf, hintOf } from "./model";

const node = (kind: string, hint: string | null, extra: Record<string, unknown> = {}): TreeNode =>
  ({ id: "x", kind, name: "n", hint, path: ["n"], hasChildren: false, extra }) as unknown as TreeNode;

describe("object comments", () => {
  it("are a tooltip, not an inline hint, for schemas, tables, views and databases", () => {
    for (const kind of ["schema", "table", "view", "materializedView", "database"]) {
      const n = node(kind, "Demo shop", kind === "database" ? { comment: "Demo shop" } : {});
      expect(hintOf(n)).toBeUndefined();
      expect(commentOf(n)).toBe("Demo shop");
    }
  });
  it("prefers extra.comment and ignores the SQLite file / MySQL VIEW placeholders", () => {
    expect(commentOf(node("table", "short", { comment: "Product categories" }))).toBe("Product categories");
    expect(commentOf(node("schema", "/tmp/x.db", { file: "/tmp/x.db" }))).toBeUndefined();
    expect(commentOf(node("view", "VIEW", { comment: "VIEW" }))).toBeUndefined();
    expect(commentOf(node("table", null, { comment: "  " }))).toBeUndefined();
  });
  it("keeps the other hints", () => {
    expect(hintOf(node("folder", "7"))).toBe("7");
    expect(commentOf(node("folder", "7"))).toBeUndefined();
  });
});
