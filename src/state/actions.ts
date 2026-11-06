/**
 * Action registry + keymap dispatcher.
 *
 * An action has an id, a title, an optional shortcut and `enabled()` / `run()`. Menus, toolbars and
 * keyboard shortcuts all go through it. Registering an action with an id that already exists
 * *overrides* it (the latest registration wins); the returned disposer restores the previous one.
 * Core actions without an implementation are registered as stubs (no `run`) so that menus show them
 * disabled; another module enables them just by registering the same id with a `run`.
 *
 *   const dispose = registerAction({ id: "db.newConsole", title: "New Query Console",
 *                                    shortcut: "Ctrl+Shift+Q", run: () => openConsole() });
 *
 * Shortcut syntax: "Ctrl+Alt+Shift+S", "Alt+1", "Shift+Escape", "F4", "Ctrl+Enter", "Shift Shift".
 */
import { createSignal } from "solid-js";

export interface Action {
  id: string;
  /** Menu / tooltip title, without mnemonics or trailing dots handled by the caller ("Data Sources…"). */
  title: string;
  /** One or several shortcuts; the first one is displayed. */
  shortcut?: string | string[];
  /** Icon name from src/assets/icons (see components/ui/Icon). */
  icon?: string;
  /** Without `run` the action is a stub and always reported as disabled. */
  run?: (ctx?: unknown) => void | Promise<void>;
  enabled?: () => boolean;
  /** Toggle state for menus (renders a check mark). */
  checked?: () => boolean;
  /**
   * Context guard for shortcuts: when several actions share a shortcut (Ctrl+Enter = Execute in the
   * editor, Submit in the grid), the ones whose `when()` is true win over unguarded ones.
   */
  when?: () => boolean;
}

const [version, setVersion] = createSignal(0);
const stack: Action[] = []; // registration order; later wins

export function registerAction(a: Action): () => void {
  stack.push(a);
  setVersion((v) => v + 1);
  return () => {
    const i = stack.lastIndexOf(a);
    if (i >= 0) stack.splice(i, 1);
    setVersion((v) => v + 1);
  };
}

export function registerActions(list: Action[]): () => void {
  const disposers = list.map(registerAction);
  return () => disposers.forEach((d) => d());
}

/** Reactive lookup (tracks registrations). */
export function getAction(id: string): Action | undefined {
  version();
  // An implemented action (with `run`) always wins over a stub, whatever the registration order.
  let stubFound: Action | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const a = stack[i];
    if (a.id !== id) continue;
    if (a.run) return a;
    stubFound ??= a;
  }
  return stubFound;
}

export function isActionEnabled(a: Action | undefined): boolean {
  if (!a || !a.run) return false;
  return a.enabled ? a.enabled() : true;
}

export function actionShortcut(a: Action | undefined): string | undefined {
  const s = a?.shortcut;
  return Array.isArray(s) ? s[0] : s;
}

export async function runAction(id: string, ctx?: unknown): Promise<void> {
  const a = getAction(id);
  if (a && isActionEnabled(a)) await a.run!(ctx);
}

// ---------------------------------------------------------------- keymap

interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  ins: "insert",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  space: " ",
  return: "enter",
  pgup: "pageup",
  pgdn: "pagedown",
  backslash: "\\",
  slash: "/",
  quote: "'",
};

function parseChord(s: string): Chord {
  const parts = s.split("+");
  const key = parts.pop()!.toLowerCase();
  const mods = parts.map((p) => p.toLowerCase());
  return {
    ctrl: mods.includes("ctrl") || mods.includes("control"),
    alt: mods.includes("alt"),
    shift: mods.includes("shift"),
    meta: mods.includes("meta") || mods.includes("cmd"),
    key: KEY_ALIASES[key] ?? key,
  };
}

function eventKey(e: KeyboardEvent): string {
  const c = e.code;
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (c === "Backslash") return "\\";
  if (c === "Slash") return "/";
  if (c === "Quote") return "'";
  return e.key.toLowerCase();
}

function matches(ch: Chord, e: KeyboardEvent): boolean {
  return (
    ch.ctrl === e.ctrlKey &&
    ch.alt === e.altKey &&
    ch.shift === e.shiftKey &&
    ch.meta === e.metaKey &&
    ch.key === eventKey(e)
  );
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function shortcutsOf(a: Action): string[] {
  return Array.isArray(a.shortcut) ? a.shortcut : a.shortcut ? [a.shortcut] : [];
}

let lastShift = 0;
let shiftTainted = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === "Shift") {
    // "Shift Shift": two quick presses of Shift with nothing in between.
    if (!e.repeat) {
      const now = performance.now();
      if (!shiftTainted && now - lastShift < 400) {
        lastShift = 0;
        if (dispatch((s) => s === "Shift Shift", e)) e.preventDefault();
      } else {
        lastShift = now;
      }
      shiftTainted = false;
    }
    return;
  }
  if (e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
  shiftTainted = true;
  lastShift = 0;
  const editable = isEditable(e.target);
  const hasMod = e.ctrlKey || e.altKey || e.metaKey;
  const fnKey = /^F\d+$/.test(e.key) || e.key === "Escape";
  // Plain typing in text fields must not trigger single-key shortcuts.
  if (editable && !hasMod && !fnKey) return;
  if (dispatch((s) => s !== "Shift Shift" && matches(parseChord(s), e), e)) e.preventDefault();
}

function dispatch(match: (shortcut: string) => boolean, _e: KeyboardEvent): boolean {
  const candidates: Action[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const a = stack[i];
    if (!isActionEnabled(a)) continue;
    if (shortcutsOf(a).some(match)) candidates.push(a);
  }
  if (!candidates.length) return false;
  const guarded = candidates.find((a) => a.when && a.when());
  const pick = guarded ?? candidates.find((a) => !a.when);
  if (!pick) return false;
  void pick.run!();
  return true;
}

/** Installs the global keyboard dispatcher; returns an uninstall function. */
export function installKeymap(): () => void {
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
