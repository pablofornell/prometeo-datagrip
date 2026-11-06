/**
 * Modal dialog frame like DataGrip's: title bar (draggable), content, footer buttons.
 * Esc cancels, Enter presses the primary (default) button (not inside textareas / buttons).
 *
 *   <Dialog title="About" onClose={close} buttons={[{ label: "OK", primary: true, run: close }]}>...</Dialog>
 *
 * Tab focus is trapped inside; the previously focused element regains focus on close.
 */
import { For, type JSX, Show, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "./Button";
import { Icon } from "./Icon";

export interface DialogButton {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  run?: () => void;
}

export interface DialogProps {
  title: string;
  onClose: () => void;
  /** Footer buttons, left to right (DataGrip order: OK, Cancel, Apply). */
  buttons?: DialogButton[];
  /** Left side of the footer (help button, "Test Connection" link...). */
  footerLeft?: JSX.Element;
  width?: number;
  height?: number;
  children?: JSX.Element;
  /** Content padding (default 16px). Use 0 for tabbed layouts. */
  flush?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

export function Dialog(props: DialogProps): JSX.Element {
  let frame!: HTMLDivElement;
  let prev: HTMLElement | null = null;
  let offset = { x: 0, y: 0 };

  onMount(() => {
    prev = document.activeElement as HTMLElement | null;
    document.body.classList.add("dg-modal-open");
    const first = frame.querySelector<HTMLElement>("[data-autofocus]") ?? frame.querySelector<HTMLElement>(".dg-dialog-body " + FOCUSABLE);
    (first ?? frame).focus();
  });
  onCleanup(() => {
    document.body.classList.remove("dg-modal-open");
    prev?.focus?.({ preventScroll: true });
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON") return;
      const def = props.buttons?.find((b) => b.primary && !b.disabled);
      if (def) {
        e.preventDefault();
        def.run?.();
      }
    } else if (e.key === "Tab") {
      const els = [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const startDrag = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".dg-dialog-close")) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const sx = e.clientX - offset.x;
    const sy = e.clientY - offset.y;
    const move = (ev: PointerEvent) => {
      offset = { x: ev.clientX - sx, y: ev.clientY - sy };
      frame.style.transform = `translate(${offset.x}px, ${offset.y}px)`;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return (
    <Portal>
      <div class="dg-dialog-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) e.preventDefault(); }}>
        <div
          ref={frame}
          class="dg-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={props.title}
          tabindex={-1}
          style={{ width: (props.width ?? 480) + "px", height: props.height ? props.height + "px" : undefined }}
          onKeyDown={onKeyDown}
        >
          <div class="dg-dialog-titlebar" onPointerDown={startDrag}>
            <span class="dg-dialog-title">{props.title}</span>
            <span class="dg-dialog-close" onClick={() => props.onClose()}>
              <Icon name="close" />
            </span>
          </div>
          <div class="dg-dialog-body" classList={{ "dg-flush": props.flush }}>
            {props.children}
          </div>
          <Show when={props.buttons?.length || props.footerLeft}>
            <div class="dg-dialog-footer">
              <div class="dg-dialog-footer-left">{props.footerLeft}</div>
              <For each={props.buttons}>
                {(b) => (
                  <Button primary={b.primary} disabled={b.disabled} onClick={() => b.run?.()}>
                    {b.label}
                  </Button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
