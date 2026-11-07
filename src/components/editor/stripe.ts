import type { Extension } from "@codemirror/state";
import { completionStatus } from "@codemirror/autocomplete";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { identifierAtCaret } from "./highlight";
import { previewField } from "./frame";
import { jumpProblem } from "./inspect";
import { errorsField, problemsField } from "./state";

const CHECK =
  '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 8.6l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ERRDOT =
  '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor"/><rect x="7.2" y="4.4" width="1.6" height="4.4" rx=".8" fill="#fff"/><circle cx="8" cy="10.9" r=".9" fill="#fff"/></svg>';
const UP = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 9.5L8 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DOWN = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M4.5 6.5L8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

class StripeView {
  stripe: HTMLElement;
  thumb: HTMLElement;
  marksEl: HTMLElement;
  widget: HTMLElement;
  private raf = 0;
  private onScroll = (): void => this.layoutThumb();

  constructor(readonly view: EditorView) {
    this.stripe = document.createElement("div");
    this.stripe.className = "cm-stripe";
    this.marksEl = document.createElement("div");
    this.marksEl.className = "cm-stripe-marks";
    this.thumb = document.createElement("div");
    this.thumb.className = "cm-stripe-thumb";
    this.stripe.append(this.marksEl, this.thumb);
    this.widget = document.createElement("div");
    this.widget.className = "cm-inspect";
    view.dom.append(this.stripe, this.widget);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.thumb.addEventListener("pointerdown", (e) => this.dragStart(e));
    this.schedule();
  }

  update(u: ViewUpdate): void {
    if (
      u.docChanged ||
      u.selectionSet ||
      u.geometryChanged ||
      u.viewportChanged ||
      u.startState.field(errorsField) !== u.state.field(errorsField) ||
      u.startState.field(problemsField) !== u.state.field(problemsField) ||
      u.startState.field(previewField) !== u.state.field(previewField) ||
      completionStatus(u.startState) !== completionStatus(u.state)
    )
      this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.stripe.remove();
    this.widget.remove();
  }

  schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private draw(): void {
    const v = this.view;
    const h = v.dom.clientHeight;
    const content = Math.max(v.contentHeight, h);
    const scale = h / content;
    const marks = new Map<number, string>(); // y -> kind
    const put = (pos: number, kind: string): void => {
      const y = Math.round(v.lineBlockAt(Math.min(pos, v.state.doc.length)).top * scale + 4);
      if (!marks.has(y) || kind === "err") marks.set(y, kind);
    };
    const id = identifierAtCaret(v);
    if (id && id.tokens.length > 1) for (const t of id.tokens) put(t.from, "id");
    const errors = v.state.field(errorsField);
    const problems = v.state.field(problemsField);
    for (const e of errors) put(errorPos(v, e.statementFrom, e.position), "err");
    for (const p of problems) put(p.from, "err");
    const frag = document.createDocumentFragment();
    const pv = v.state.field(previewField);
    if (pv) {
      const b0 = v.lineBlockAt(pv.from);
      const b1 = v.lineBlockAt(pv.to);
      const m = document.createElement("div");
      m.className = "cm-stripe-range";
      m.style.top = `${Math.round(b0.bottom * scale + 4)}px`;
      m.style.height = `${Math.max(2, Math.round((b1.bottom - b0.bottom) * scale))}px`;
      frag.append(m);
    }
    for (const [y, kind] of marks) {
      const m = document.createElement("div");
      m.className = `cm-stripe-mark cm-stripe-${kind}`;
      m.style.top = `${y}px`;
      frag.append(m);
    }
    this.marksEl.replaceChildren(frag);
    this.layoutThumb();
    this.drawWidget(errors.length + problems.length);
  }

  private drawWidget(count: number): void {
    const w = this.widget;
    if (completionStatus(this.view.state) === "active") {
      // DataGrip pauses the analysis while the completion popup is open
      w.className = "cm-inspect cm-inspect-paused";
      w.textContent = "Paused…";
      return;
    }
    if (count === 0) {
      w.className = "cm-inspect cm-inspect-ok";
      w.innerHTML = `<span class="cm-inspect-icon">${CHECK}</span>`;
      return;
    }
    w.className = "cm-inspect cm-inspect-err";
    w.innerHTML = `<span class="cm-inspect-icon">${ERRDOT}</span><span class="cm-inspect-count">${count}</span><button class="cm-inspect-nav" data-dir="-1" title="Previous Problem (Shift+F2)">${UP}</button><button class="cm-inspect-nav" data-dir="1" title="Next Problem (F2)">${DOWN}</button>`;
    w.querySelectorAll("button").forEach((b) =>
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        jumpProblem(this.view, Number((b as HTMLElement).dataset.dir) > 0 ? 1 : -1);
        this.view.focus();
      }),
    );
  }

  layoutThumb(): void {
    const sc = this.view.scrollDOM;
    const vh = sc.clientHeight;
    const ch = sc.scrollHeight;
    if (ch <= vh + 1) {
      this.thumb.style.display = "none";
      return;
    }
    const th = Math.max(30, (vh * vh) / ch);
    const top = (sc.scrollTop / (ch - vh)) * (vh - th);
    this.thumb.style.display = "block";
    this.thumb.style.height = `${th}px`;
    this.thumb.style.top = `${top}px`;
  }

  private dragStart(e: PointerEvent): void {
    e.preventDefault();
    const sc = this.view.scrollDOM;
    const startY = e.clientY;
    const startTop = sc.scrollTop;
    const vh = sc.clientHeight;
    const ch = sc.scrollHeight;
    const th = Math.max(30, (vh * vh) / ch);
    this.thumb.classList.add("dragging");
    const move = (m: PointerEvent): void => {
      sc.scrollTop = startTop + ((m.clientY - startY) * (ch - vh)) / Math.max(1, vh - th);
    };
    const up = (): void => {
      this.thumb.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}

/** Document offset of an error: statement start + 1-based server position. */
export function errorPos(view: EditorView, statementFrom: number, position?: number): number {
  const len = view.state.doc.length;
  return Math.min(len, position && position > 0 ? statementFrom + position - 1 : statementFrom);
}

export function stripeExtension(): Extension {
  return ViewPlugin.fromClass(StripeView);
}
