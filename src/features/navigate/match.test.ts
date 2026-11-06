// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isWordStart, match, matchName, prepareQuery } from "./match";

const ranges = (name: string, q: string) => match(name, q)?.ranges;

describe("matching", () => {
  it("matches word initials", () => {
    expect(ranges("order_items", "oi")).toEqual([[0, 1], [6, 7]]);
    expect(ranges("OrderItem", "oi")).toEqual([[0, 1], [5, 6]]);
    expect(ranges("order_items", "ordit")).toEqual([[0, 3], [6, 8]]);
  });
  it("is case-insensitive and rejects non-matches", () => {
    expect(match("Customers", "CUST")).not.toBeNull();
    expect(match("customers", "xyz")).toBeNull();
    expect(match("abc", "abcd")).toBeNull();
  });
  it("treats separators in the query as chunk breaks", () => {
    expect(ranges("order_items", "ord_it")).toEqual([[0, 3], [6, 8]]);
    expect(ranges("New Query Console", "new con")).toEqual([[0, 3], [10, 13]]);
  });
  it("finds in-word substrings last", () => {
    expect(ranges("order_items", "der")).toEqual([[2, 5]]);
  });
  it("ranks exact > prefix > word start > substring", () => {
    const s = (n: string) => match(n, "ord", false)!.score;
    expect(s("ord")).toBeGreaterThan(s("orders"));
    expect(s("orders")).toBeGreaterThan(s("big_order"));
    expect(s("big_order")).toBeGreaterThan(s("recorded"));
  });
  it("prefers fewer chunks", () => {
    const a = match("order_items", "oi", false)!.score;
    const b = match("o_x_i", "oi", false)!.score;
    expect(a).toBeGreaterThanOrEqual(b);
  });
  it("detects word starts", () => {
    expect(isWordStart("HTMLParser", 4)).toBe(true);
    expect(isWordStart("HTMLParser", 1)).toBe(false);
    expect(isWordStart("a_b", 2)).toBe(true);
  });
  it("is fast for 10k names", () => {
    const names = Array.from({ length: 20000 }, (_, i) => `table_${i}_order_items_v${i % 7}`);
    const lower = names.map((n) => n.toLowerCase());
    const q = prepareQuery("toi");
    const t = performance.now();
    let hits = 0;
    for (let i = 0; i < names.length; i++) if (matchName(names[i], lower[i], q)) hits++;
    expect(hits).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
