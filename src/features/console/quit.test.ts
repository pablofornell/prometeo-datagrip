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
  it("a second close request while the prompt is open neither quits nor asks again: it focuses the dialog", async () => {
    const quit = vi.fn(async () => {});
    const focus = vi.fn();
    let answer!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const h = createQuitHandler({ confirm, quit, focus });
    const first = h(ev());
    const e2 = ev();
    const second = h(e2); // a double click on the close button
    await Promise.resolve();
    expect(e2.preventDefault).toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    answer(true);
    await Promise.all([first, second]);
    expect(quit).toHaveBeenCalledTimes(1); // once, after the answer
  });
  it("close requests while the COMMIT the user chose is running wait for it (probe: vt/quit.test.ts)", async () => {
    const log: string[] = [];
    let finishCommit!: () => void;
    const h = createQuitHandler({
      confirm: () => new Promise<boolean>((r) => (finishCommit = () => (log.push("commit finished"), r(true)))),
      quit: async () => void log.push("QUIT"),
    });
    const first = h(ev());
    const second = h(ev()).then(() => log.push("2nd request returned"));
    await Promise.resolve();
    expect(log).toEqual([]); // nothing quit while the COMMIT runs
    finishCommit();
    await Promise.all([first, second]);
    expect(log).toEqual(["commit finished", "QUIT", "2nd request returned"]);
  });
  it("a cancelled guard lets the next request ask again", async () => {
    const quit = vi.fn(async () => {});
    let answer!: (v: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const h = createQuitHandler({ confirm, quit });
    const first = h(ev());
    answer(false);
    await first;
    void h(ev());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(quit).not.toHaveBeenCalled();
  });
  it("quits when the guard itself throws", async () => {
    const quit = vi.fn(async () => {});
    const h = createQuitHandler({ confirm: async () => Promise.reject(new Error("boom")), quit });
    await h(ev());
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
