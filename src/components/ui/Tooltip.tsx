/**
 * Tooltips with DataGrip timing and look. Delegated: any element with `data-tip` gets one, so toolbars
 * only need the attributes (see `tip()`); mount <TooltipHost/> once.
 *
 *   <button {...tip("Add Row", "Alt+Insert")} />
 *
 * DataGrip shows a tooltip after ~1.2 s of hover; once one was shown, neighbours show almost at once.
 * Multi-line text is supported with "\n".
 */
import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export function tip(text?: string, shortcut?: string): Record<string, string | undefined> {
  return { "data-tip": text || undefined, "data-tip-shortcut": shortcut || undefined };
}

const INITIAL_DELAY = 1200;
const REUSE_DELAY = 80;
const REUSE_WINDOW = 800;

export function TooltipHost(): JSX.Element {
  const [shown, setShown] = createSignal<{ text: string; shortcut?: string; x: number; y: number } | null>(null);
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(null);
  let el: HTMLDivElement | undefined;
  let timer = 0;
  let anchor: Element | null = null;
  let mx = 0;
  let my = 0;
  let lastHidden = 0;

  const hide = () => {
    window.clearTimeout(timer);
    if (shown()) lastHidden = performance.now();
    setShown(null);
    setPos(null);
  };

  const over = (e: MouseEvent) => {
    const t = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
    if (t === anchor) return;
    hide();
    anchor = t;
    if (!t) return;
    const delay = performance.now() - lastHidden < REUSE_WINDOW ? REUSE_DELAY : INITIAL_DELAY;
    timer = window.setTimeout(() => {
      const text = (t as HTMLElement).dataset.tip;
      if (text) setShown({ text, shortcut: (t as HTMLElement).dataset.tipShortcut, x: mx, y: my });
    }, delay);
  };
  const move = (e: MouseEvent) => {
    mx = e.clientX;
    my = e.clientY;
  };

  onMount(() => {
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, true);
    window.addEventListener("blur", hide);
    onCleanup(() => {
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    });
  });

  createEffect(() => {
    const s = shown();
    if (!s || !el) return;
    let left = s.x;
    let top = s.y + 18;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (left + w > window.innerWidth - 4) left = Math.max(4, window.innerWidth - w - 4);
    if (top + h > window.innerHeight - 4) top = Math.max(4, s.y - h - 8);
    setPos({ left, top });
  });

  return (
    <Show when={shown()}>
      {(s) => (
        <Portal>
          <div
            ref={el}
            class="dg-tooltip"
            style={{ left: (pos()?.left ?? 0) + "px", top: (pos()?.top ?? 0) + "px", visibility: pos() ? "visible" : "hidden" }}
          >
            <For each={s().text.split("\n")}>
              {(line, i) => (
                <div class="dg-tooltip-line" classList={{ "dg-tooltip-desc": i() > 0 }}>
                  {line}
                  <Show when={i() === 0 && s().shortcut}>
                    <span class="dg-tooltip-shortcut">{s().shortcut}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Portal>
      )}
    </Show>
  );
}
