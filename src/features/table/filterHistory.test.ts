// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/db", () => ({ getUiState: async () => undefined, setUiState: async () => undefined }));

import { HISTORY_LIMIT, filterHistory, rememberFilter, resetFilterHistory } from "./filterHistory";

beforeEach(() => resetFilterHistory());

describe("filter history", () => {
  it("keeps the newest first and moves a repeated text to the front", () => {
    rememberFilter("t", "where", "a = 1");
    rememberFilter("t", "where", "b = 2");
    rememberFilter("t", "where", "a = 1");
    expect(filterHistory("t", "where")).toEqual(["a = 1", "b = 2"]);
  });

  it("keeps WHERE and ORDER BY and the tables apart; ignores empty texts", () => {
    rememberFilter("t", "where", "x");
    rememberFilter("t", "order", "id desc");
    rememberFilter("u", "where", "y");
    rememberFilter("t", "where", "   ");
    expect(filterHistory("t", "where")).toEqual(["x"]);
    expect(filterHistory("t", "order")).toEqual(["id desc"]);
    expect(filterHistory("u", "where")).toEqual(["y"]);
  });

  it("keeps at most 20 entries", () => {
    for (let i = 0; i < 30; i++) rememberFilter("t", "where", `id = ${i}`);
    const h = filterHistory("t", "where");
    expect(h).toHaveLength(HISTORY_LIMIT);
    expect(h[0]).toBe("id = 29");
  });
});
