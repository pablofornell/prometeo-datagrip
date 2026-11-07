// @vitest-environment node
import { describe, expect, it } from "vitest";
import { anchorRect, clearAnchorRedirect, redirectAnchor } from "./anchor-redirect";
import { controlOf, fitCount, labelOf } from "./overflow-fit";

/** A DOM element reduced to what the overflow code reads (the tests run without a DOM). */
interface Fake {
  tagName: string;
  textContent: string;
  dataset: Record<string, string>;
  parentElement: Fake | null;
  rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
  inner?: Fake;
  getAttribute(n: string): string | null;
  getBoundingClientRect(): unknown;
  querySelector(sel: string): Fake | null;
}
const BOX = { left: 40, right: 62, top: 5, bottom: 27, width: 22, height: 22 };
const NONE = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
const fake = (tagName: string, o: { text?: string; tip?: string; title?: string; rect?: Fake["rect"]; parent?: Fake } = {}): Fake => {
  const f: Fake = {
    tagName,
    textContent: o.text ?? "",
    dataset: o.tip ? { tip: o.tip } : {},
    parentElement: o.parent ?? null,
    rect: o.rect ?? BOX,
    getAttribute: (n) => (n === "title" ? (o.title ?? null) : null),
    getBoundingClientRect: () => f.rect,
    querySelector: (sel) => (sel === "button" ? (f.inner ?? null) : null),
  };
  return f;
};
const el = (f: Fake) => f as never;

describe("fitCount", () => {
  const w = [22, 22, 22, 22, 22]; // five buttons, 4px gaps: 5 * 22 + 4 * 4 = 126 px

  it("keeps everything when it fits (no » button needed)", () => {
    expect(fitCount(w, 4, 126, 26)).toBe(5);
    expect(fitCount(w, 4, 400, 26)).toBe(5);
  });

  it("cuts from the right and leaves room for the » button", () => {
    // 100 px: 3 buttons (3 * 26 = 78) + » (26) = 104 > 100, so 2 buttons (52) + 26 = 78
    expect(fitCount(w, 4, 100, 26)).toBe(2);
    expect(fitCount(w, 4, 104, 26)).toBe(3);
  });

  it("can keep nothing", () => {
    expect(fitCount(w, 4, 10, 26)).toBe(0);
    expect(fitCount([], 4, 0, 26)).toBe(0);
  });
});

describe("controlOf / labelOf (the entry of a hidden toolbar item)", () => {
  it("a button stands for itself", () => {
    const b = fake("BUTTON", { text: "Tx: Auto" });
    expect(controlOf(el(b))).toBe(b);
    expect(labelOf(el(b))).toBe("Tx: Auto");
  });
  it("a wrapper (the .dgc-run span) stands for the first button inside it, and takes its tooltip as label", () => {
    const span = fake("SPAN");
    const btn = fake("BUTTON", { tip: "Execute", parent: span });
    span.inner = btn;
    expect(controlOf(el(span))).toBe(btn);
    expect(labelOf(el(span))).toBe("Execute");
  });
  it("falls back to the title attribute, else an empty label", () => {
    expect(labelOf(el(fake("BUTTON", { title: "Run" })))).toBe("Run");
    expect(labelOf(el(fake("BUTTON")))).toBe("");
  });
});

describe("anchorRect (popups opened after an await from a hidden toolbar item)", () => {
  const more = fake("BUTTON", { rect: { left: 300, right: 322, top: 5, bottom: 27, width: 22, height: 22 } });
  it("an element with a box anchors to itself", () => {
    const b = fake("BUTTON");
    redirectAnchor(el(b), el(more));
    expect(anchorRect(el(b))).toBe(b.rect);
    clearAnchorRedirect(el(b));
  });
  it("a hidden item anchors to the » button, also long after the click", async () => {
    const b = fake("BUTTON", { rect: NONE });
    redirectAnchor(el(b), el(more));
    await new Promise((r) => setTimeout(r, 5)); // the handler awaited something
    expect(anchorRect(el(b))).toBe(more.rect);
  });
  it("so does a button inside a hidden wrapper", () => {
    const span = fake("SPAN", { rect: NONE });
    const btn = fake("BUTTON", { rect: NONE, parent: span });
    redirectAnchor(el(span), el(more));
    expect(anchorRect(el(btn))).toBe(more.rect);
  });
  it("an item shown again (or never hidden) keeps its own zero box: no stale redirect", () => {
    const b = fake("BUTTON", { rect: NONE });
    redirectAnchor(el(b), el(more));
    clearAnchorRedirect(el(b));
    expect(anchorRect(el(b))).toBe(b.rect);
  });
});
