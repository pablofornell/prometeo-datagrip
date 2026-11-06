// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createQuitHandler } from "./quit";

const ev = () => ({ preventDefault: vi.fn() });

describe("the quit guard", () => {
  it("quits after the user answered", async () => {
    const quit = vi.fn(async () => {});
    const h = createQuitHandler({ confirm: async () => true, quit });
    const e = ev();
    await h(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });
  it("Cancel keeps the application open, and asks again next time", async () => {
    const quit = vi.fn(async () => {});
    const confirm = vi.fn(async () => false);
    const h = createQuitHandler({ confirm, quit });
    await h(ev());
    await h(ev());
    expect(quit).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("a second quit request while the prompt is open quits (a stuck prompt is no dead end)", async () => {
    const quit = vi.fn(async () => {});
    const h = createQuitHandler({ confirm: () => new Promise<boolean>(() => {}), quit });
    void h(ev());
    await h(ev());
    expect(quit).toHaveBeenCalledTimes(1);
  });
  it("quits when the guard itself throws", async () => {
    const quit = vi.fn(async () => {});
    const h = createQuitHandler({ confirm: async () => Promise.reject(new Error("boom")), quit });
    await h(ev());
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
