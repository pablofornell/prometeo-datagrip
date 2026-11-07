/**
 * Frame shared by the Modify Table / New Table dialog and the small object dialogs (view, sequence, schema):
 * toolbar over an object tree (left) and the property sheet (right), a collapsible SQL Preview, OK / Cancel.
 * No title bar, like DataGrip's (`104-modify-table-dialog-dark.png`).
 */
import { Show, type JSX, createEffect, createSignal, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { SqlEditor } from "../../components/editor";
import { Button, Icon, tip } from "../../components/ui";
import type { Driver } from "./model";
import "./schema-editor.css";

export interface FrameProps {
  toolbar: JSX.Element;
  tree: JSX.Element;
  sheet: JSX.Element;
  /** The generated statements. */
  preview: string;
  dialect: Driver;
  /** Nothing to apply (green check, OK disabled in modify mode). */
  unchanged?: boolean;
  /** Why OK is refused (validation or the plan's error); red under the preview. */
  problem?: string;
  warnings?: string[];
  busy?: boolean;
  /** Server error of the last OK. */
  applyError?: string;
  canOk: boolean;
  okLabel?: string;
  onOk: () => void;
  onCancel: () => void;
  /** Open the preview in a console instead of running it. */
  onConsole?: () => void;
  defaultSchemaHint?: string;
}

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])';

export function EditorFrame(props: FrameProps): JSX.Element {
  let frame!: HTMLDivElement;
  const [previewOpen, setPreviewOpen] = createSignal(true);

  // a disabled button that had the focus drops it to <body>, and Esc / Enter would no longer reach the dialog
  createEffect(() => {
    props.busy;
    props.problem;
    queueMicrotask(() => {
      const a = document.activeElement;
      if (!a || a === document.body) frame?.focus();
    });
  });

  onMount(() => {
    const field = frame.querySelector<HTMLInputElement>('input[data-name="1"]');
    (field ?? frame).focus();
    field?.select();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      // keep the focus inside the dialog
      const els = [...frame.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!els.length) return;
      const [first, last] = [els[0], els[els.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.isContentEditable || t.closest(".dgse-tree")) return;
      if (props.canOk && !props.busy) {
        e.preventDefault();
        props.onOk();
      }
    }
  };

  return (
    <Portal>
      <div class="dg-dialog-overlay" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
        <div ref={frame} class="dg-dialog dgse" role="dialog" aria-label="Modify" tabindex={-1} onKeyDown={onKeyDown}>
          <div class="dgse-main">
            <div class="dgse-toolbar" role="toolbar">
              {props.toolbar}
            </div>
            <div class="dgse-split">
              <div class="dgse-left">{props.tree}</div>
              <div class="dgse-right">{props.sheet}</div>
            </div>
          </div>
          <div class="dgse-preview-head" onClick={() => setPreviewOpen(!previewOpen())}>
            <Icon name={previewOpen() ? "chevron-down" : "chevron-right"} />
            <span class="dgse-preview-title">Preview</span>
            <span class="dgse-preview-line" />
            <Show when={props.onConsole}>
              <span
                class="dgse-preview-btn"
                {...tip("Open in Query Console")}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onConsole?.();
                }}
              >
                <Icon name="open-new-tab" />
              </span>
            </Show>
          </div>
          <Show when={previewOpen()}>
            <div class="dgse-preview">
              <SqlEditor value={props.preview} dialect={props.dialect} readOnly gutter={false} stripe={false} statementFrame={false} />
              <Show when={!props.problem && !props.applyError}>
                <span class="dgse-preview-ok">
                  <Icon name="green-checkmark" />
                </span>
              </Show>
            </div>
          </Show>
          <Show when={props.problem || props.applyError || props.warnings?.length}>
            <div class="dgse-notes">
              <Show when={props.applyError}>
                <div class="dgse-error">{props.applyError}</div>
              </Show>
              <Show when={props.problem}>
                <div class="dgse-error">{props.problem}</div>
              </Show>
              {(props.warnings ?? []).map((w) => (
                <div class="dgse-warning">{w}</div>
              ))}
            </div>
          </Show>
          <div class="dg-dialog-footer">
            <div class="dg-dialog-footer-left" />
            <Button primary disabled={!props.canOk} onClick={() => !props.busy && props.onOk()}>
              {props.okLabel ?? "OK"}
            </Button>
            <Button onClick={props.onCancel}>Cancel</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** 22px toolbar button with its own small icon. */
export function TbButton(props: { title: string; disabled?: boolean; onClick: () => void; children: JSX.Element; ref?: (el: HTMLButtonElement) => void }): JSX.Element {
  return (
    <button
      type="button"
      ref={props.ref}
      class="dg-action-button dgse-tb"
      classList={{ "dg-disabled": props.disabled }}
      aria-disabled={props.disabled}
      tabindex={-1}
      {...tip(props.title)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => !props.disabled && props.onClick()}
    >
      {props.children}
    </button>
  );
}

export const ArrowUp = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 13V3M4 7l4-4 4 4" />
  </svg>
);
export const ArrowDown = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 3v10M4 9l4 4 4-4" />
  </svg>
);
