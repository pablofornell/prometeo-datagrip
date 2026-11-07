import { EditorSelection, type EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { type Command, EditorView, type Panel, type ViewUpdate, keymap, runScopeHandlers } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import { docAnalysis } from "./highlight";
import { configField } from "./state";
import type { MenuItem } from "../ui/Menu";

const icons = import.meta.glob("../../assets/icons/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function iconUrl(name: string): string {
  const dark = document.documentElement.dataset.theme !== "light";
  return icons[`../../assets/icons/${name}${dark ? "_dark" : ""}.svg`] ?? icons[`../../assets/icons/${name}.svg`] ?? "";
}

function img(name: string): HTMLImageElement {
  const i = document.createElement("img");
  i.src = iconUrl(name);
  i.width = 16;
  i.height = 16;
  i.draggable = false;
  return i;
}

function button(cls: string, title: string, child: HTMLElement | string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = title;
  b.tabIndex = -1;
  if (typeof child === "string") b.textContent = child;
  else b.append(child);
  // keep focus in the input field / editor
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

let wantReplace = false;

/** Last queries of the search / replace fields (newest first, 20 kept): the `⌄` menus of the fields. */
const searchHistory: string[] = [];
const replaceHistory: string[] = [];
function remember(list: string[], text: string): void {
  if (!text) return;
  const i = list.indexOf(text);
  if (i >= 0) list.splice(i, 1);
  list.unshift(text);
  list.length = Math.min(list.length, 20);
}

/** The funnel menu: where the matches may be. */
type Scope = "all" | "comments" | "strings" | "exceptComments" | "exceptStrings";
let scopeMode: Scope = "all";
const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "Anywhere" },
  { id: "comments", label: "In Comments Only" },
  { id: "strings", label: "In String Literals Only" },
  { id: "exceptComments", label: "Except Comments" },
  { id: "exceptStrings", label: "Except String Literals" },
];

/** Whether a match at `from..to` lies in the part of the script the scope allows. */
function scopeTest(scope: Scope): ((match: string, state: EditorState, from: number, to: number) => boolean) | undefined {
  if (scope === "all") return undefined;
  return (_m, state, from, to) => {
    const toks = docAnalysis(state.doc, state.field(configField).dialect).tokens;
    let lo = 0;
    let hi = toks.length - 1;
    let hit: (typeof toks)[number] | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid].to <= from) lo = mid + 1;
      else if (toks[mid].from > from) hi = mid - 1;
      else {
        hit = toks[mid];
        break;
      }
    }
    const kind = hit && hit.from <= from && to <= hit.to ? hit.kind : undefined;
    const inComment = kind === "comment";
    const inString = kind === "string";
    return scope === "comments" ? inComment : scope === "strings" ? inString : scope === "exceptComments" ? !inComment : !inString;
  };
}

/** CodeMirror's reading of a replacement text: `\\n`, `\\r`, `\\t` and `\\\\` are the characters they name. */
function unquote(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_m, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : "\\"));
}

/** The replacement keeps the case pattern of the match: `Price` -> `Cost`, `PRICE` -> `COST`. */
export function preserveCase(match: string, replacement: string): string {
  if (!match || !/[A-Za-z]/.test(match)) return replacement;
  if (match === match.toUpperCase() && match.length > 1) return replacement.toUpperCase();
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  if (match[0] === match[0].toUpperCase() && match.slice(1) === match.slice(1).toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  return replacement;
}

const NEWLINE_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M12.5 4v4.5H5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.2 6.3L4.8 8.5l2.4 2.2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function svgButton(cls: string, title: string, svg: string): HTMLButtonElement {
  const b = button(cls, title, "");
  b.innerHTML = svg;
  return b;
}

function field(icon: string, name: string, placeholder: string): { frame: HTMLElement; input: HTMLInputElement; history: HTMLButtonElement } {
  const frame = document.createElement("div");
  frame.className = "cm-find-field";
  const input = document.createElement("input");
  input.className = "cm-find-input";
  input.name = name;
  input.placeholder = placeholder;
  input.spellcheck = false;
  const history = button("cm-find-btn cm-find-hist", "History", img("chevron-down"));
  frame.append(img(icon), history, input);
  return { frame, input, history };
}

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private searchInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private count: HTMLElement;
  private toggles: Record<"case" | "word" | "regexp", HTMLButtonElement>;
  private preserve: HTMLButtonElement;
  private collapse: HTMLButtonElement;
  private clear: HTMLButtonElement;
  private funnel: HTMLButtonElement;
  private replaceRow: HTMLElement;
  private query: SearchQuery;
  private preserveOn = false;
  /** Matches (by start offset) that `Exclude` took out of the replacement. */
  private excluded = new Set<number>();

  constructor(readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const root = document.createElement("div");
    root.className = "cm-find";
    root.addEventListener("keydown", (e) => this.keydown(e));

    // ---- row 1: collapse | search field | counter, previous, next, funnel, more | close
    const row = document.createElement("div");
    row.className = "cm-find-row";
    this.collapse = button("cm-find-btn cm-find-collapse", "Toggle Replace (Ctrl+R)", img("chevron-down"));
    this.collapse.addEventListener("click", () => {
      wantReplace = this.replaceRow.style.display === "none";
      this.showReplace(wantReplace && !view.state.readOnly);
    });
    const sf = field("search", "search", "Search");
    this.searchInput = sf.input;
    this.searchInput.setAttribute("main-field", "true");
    this.searchInput.value = this.query.search;
    this.searchInput.addEventListener("input", () => this.commit(true));
    sf.history.addEventListener("click", () => this.openHistory(sf.history, searchHistory, this.searchInput));
    this.clear = button("cm-find-btn cm-find-clear", "Clear", img("close-small"));
    this.clear.addEventListener("click", () => {
      this.searchInput.value = "";
      this.commit(false);
      this.searchInput.focus();
    });
    const nl = svgButton("cm-find-toggle", "New Line (Ctrl+Shift+Enter)", NEWLINE_SVG);
    nl.addEventListener("click", () => this.insertNewline(this.searchInput));
    this.toggles = {
      case: button("cm-find-toggle cm-find-text", "Match Case (Alt+C)", "Cc"),
      word: button("cm-find-toggle cm-find-text", "Words (Alt+W)", "W"),
      regexp: button("cm-find-toggle cm-find-text", "Regex (Alt+X)", ".*"),
    };
    for (const [k, b] of Object.entries(this.toggles)) {
      b.addEventListener("click", () => {
        this.toggle(k as "case" | "word" | "regexp");
      });
    }
    sf.frame.append(this.clear, nl, this.toggles.case, this.toggles.word, this.toggles.regexp);
    this.count = document.createElement("span");
    this.count.className = "cm-find-count";
    const prev = button("cm-find-btn", "Previous Occurrence (Shift+F3)", img("chevron-up"));
    prev.addEventListener("click", () => this.step(false));
    const next = button("cm-find-btn", "Next Occurrence (F3)", img("chevron-down"));
    next.addEventListener("click", () => this.step(true));
    this.funnel = button("cm-find-btn", "Filter Search Results", img("filter"));
    this.funnel.addEventListener("click", () => this.openScopeMenu());
    const more = button("cm-find-btn", "More", img("more-vertical"));
    more.addEventListener("click", () => this.openMore(more));
    const close = button("cm-find-btn cm-find-close", "Close (Escape)", img("close"));
    close.addEventListener("click", () => this.close());
    row.append(this.collapse, sf.frame, this.count, prev, next, this.funnel, more, close);

    // ---- row 2: replace field | buttons
    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "cm-find-row cm-find-replace";
    const spacer = document.createElement("span");
    spacer.className = "cm-find-btn cm-find-collapse";
    const rf = field("edit", "replace", "Replace");
    this.replaceInput = rf.input;
    this.replaceInput.value = this.query.replace;
    this.replaceInput.addEventListener("input", () => this.commit(false));
    rf.history.addEventListener("click", () => this.openHistory(rf.history, replaceHistory, this.replaceInput));
    const rnl = svgButton("cm-find-toggle", "New Line (Ctrl+Shift+Enter)", NEWLINE_SVG);
    rnl.addEventListener("click", () => this.insertNewline(this.replaceInput));
    this.preserve = button("cm-find-toggle cm-find-text", "Preserve Case", "AA");
    this.preserve.addEventListener("click", () => {
      this.preserveOn = !this.preserveOn;
      this.preserve.classList.toggle("on", this.preserveOn);
    });
    rf.frame.append(rnl, this.preserve);
    const rep = button("cm-find-text-btn", "Replace (Enter)", "Replace");
    rep.addEventListener("click", () => this.replaceOne());
    const repAll = button("cm-find-text-btn", "Replace All (Ctrl+Alt+Enter)", "Replace All");
    repAll.addEventListener("click", () => this.replaceEvery());
    const exclude = button("cm-find-text-btn", "Exclude the current occurrence from Replace All", "Exclude");
    exclude.addEventListener("click", () => this.excludeCurrent());
    this.replaceRow.append(spacer, rf.frame, rep, repAll, exclude);

    root.append(row, this.replaceRow);
    this.dom = root;
    this.syncToggles();
    this.showReplace(wantReplace && !view.state.readOnly);
    this.updateCount();
  }

  private sizer?: ResizeObserver;

  mount(): void {
    // the inspection widget and the error stripe sit below the bar (it pushes the text down)
    const sync = (): void => this.view.dom.style.setProperty("--cm-find-h", `${this.dom.parentElement?.offsetHeight ?? this.dom.offsetHeight}px`);
    this.sizer = new ResizeObserver(sync);
    this.sizer.observe(this.dom);
    sync();
    (wantReplace && !this.view.state.readOnly ? this.replaceInput : this.searchInput).focus();
    this.searchInput.select();
  }

  destroy(): void {
    this.sizer?.disconnect();
    this.view.dom.style.removeProperty("--cm-find-h");
  }

  showReplace(on: boolean): void {
    this.replaceRow.style.display = on ? "" : "none";
    this.collapse.replaceChildren(img(on ? "chevron-down" : "chevron-right"));
  }

  private close(): void {
    remember(searchHistory, this.searchInput.value);
    closeSearchPanel(this.view);
    this.view.focus();
  }

  private mk(search: string, replace: string, c: { caseSensitive: boolean; wholeWord: boolean; regexp: boolean }): SearchQuery {
    return new SearchQuery({ search, replace, caseSensitive: c.caseSensitive, wholeWord: c.wholeWord, regexp: c.regexp, test: scopeTest(scopeMode) });
  }

  private toggle(k: "case" | "word" | "regexp"): void {
    const q = this.query;
    this.setQuery(
      this.mk(q.search, q.replace, {
        caseSensitive: k === "case" ? !q.caseSensitive : q.caseSensitive,
        wholeWord: k === "word" ? !q.wholeWord : q.wholeWord,
        regexp: k === "regexp" ? !q.regexp : q.regexp,
      }),
    );
    this.selectNearest();
  }

  /** `live`: the typed text selects the first match at or after the caret, like DataGrip. */
  private commit(live: boolean): void {
    this.setQuery(this.mk(this.searchInput.value, this.replaceInput.value, this.query));
    if (live) this.selectNearest();
  }

  /** Selects the first match at or after the start of the selection (the caret does not move when there is none). */
  private selectNearest(): void {
    const q = getSearchQuery(this.view.state);
    if (!q.valid) return;
    const sel = this.view.state.selection.main;
    const cur = q.getCursor(this.view.state, sel.from);
    const r = cur.next();
    const hit = r.done ? q.getCursor(this.view.state).next() : r;
    if (hit.done) return;
    this.view.dispatch({ selection: EditorSelection.range(hit.value.from, hit.value.to), effects: EditorView.scrollIntoView(hit.value.from, { y: "nearest" }), userEvent: "select.search" });
  }

  private step(forward: boolean): void {
    remember(searchHistory, this.searchInput.value);
    (forward ? findNext : findPrevious)(this.view);
  }

  private setQuery(q: SearchQuery): void {
    if (!q.eq(this.query)) {
      this.query = q;
      this.excluded.clear();
      this.view.dispatch({ effects: setSearchQuery.of(q) as StateEffect<unknown> });
    }
  }

  private insertNewline(input: HTMLInputElement): void {
    const a = input.selectionStart ?? input.value.length;
    const b = input.selectionEnd ?? a;
    input.setRangeText("\\n", a, b, "end");
    input.focus();
    this.commit(input === this.searchInput);
  }

  private async openMenuItems(items: MenuItem[], at: HTMLElement): Promise<void> {
    const { openMenu } = await import("../ui/Menu");
    const r = at.getBoundingClientRect();
    openMenu(items, { x: r.left, y: r.bottom + 2, compact: true, minWidth: 180, onClose: () => this.view.focus() });
  }

  private openHistory(at: HTMLElement, list: string[], input: HTMLInputElement): void {
    if (!list.length) return;
    void this.openMenuItems(
      list.map((t) => ({
        label: t.length > 60 ? t.slice(0, 60) + "…" : t,
        run: () => {
          input.value = t;
          this.commit(input === this.searchInput);
          input.focus();
        },
      })),
      at,
    );
  }

  private openScopeMenu(): void {
    void this.openMenuItems(
      SCOPES.map((s) => ({
        label: s.label,
        checked: scopeMode === s.id,
        run: () => {
          scopeMode = s.id;
          this.funnel.classList.toggle("on", s.id !== "all");
          const q = this.query;
          this.setQuery(this.mk(q.search, q.replace, q));
          this.selectNearest();
        },
      })),
      this.funnel,
    );
  }

  private openMore(at: HTMLElement): void {
    void this.openMenuItems(
      [
        { label: "Select All Occurrences", shortcut: "Ctrl+Alt+Shift+J", run: () => selectMatches(this.view) },
        { label: "Clear History", run: () => { searchHistory.length = 0; replaceHistory.length = 0; } },
      ],
      at,
    );
  }

  // ---- replace
  /** The text that replaces the match `m`. */
  private replacementFor(m: string): string {
    const base = this.query.regexp ? this.query.replace : unquote(this.query.replace);
    return this.preserveOn ? preserveCase(m, base) : base;
  }

  private matches(): { from: number; to: number; text: string }[] {
    const out: { from: number; to: number; text: string }[] = [];
    const q = this.query;
    if (!q.valid) return out;
    const cur = q.getCursor(this.view.state);
    for (let r = cur.next(); !r.done && out.length < 100_000; r = cur.next()) out.push({ from: r.value.from, to: r.value.to, text: this.view.state.sliceDoc(r.value.from, r.value.to) });
    return out;
  }

  private replaceOne(): void {
    remember(replaceHistory, this.replaceInput.value);
    if (!this.preserveOn && this.excluded.size === 0 && !this.query.regexp) return void replaceNext(this.view);
    const sel = this.view.state.selection.main;
    const all = this.matches();
    const hit = all.find((m) => m.from === sel.from && m.to === sel.to) ?? all.find((m) => m.from >= sel.to && !this.excluded.has(m.from));
    if (!hit) return;
    if (this.excluded.has(hit.from)) return this.step(true);
    const q = this.query;
    const insert = q.regexp ? this.regexReplacement(hit.from, hit.to) : this.replacementFor(hit.text);
    this.view.dispatch({ changes: { from: hit.from, to: hit.to, insert }, selection: EditorSelection.cursor(hit.from + insert.length), userEvent: "input.replace", scrollIntoView: true });
    this.excluded.clear();
    this.selectNearest();
  }

  private replaceEvery(): void {
    remember(replaceHistory, this.replaceInput.value);
    if (!this.preserveOn && this.excluded.size === 0) return void replaceAll(this.view);
    const changes = this.matches()
      .filter((m) => !this.excluded.has(m.from))
      .map((m) => ({ from: m.from, to: m.to, insert: this.query.regexp ? this.regexReplacement(m.from, m.to) : this.replacementFor(m.text) }));
    if (changes.length) this.view.dispatch({ changes, userEvent: "input.replace" });
    this.excluded.clear();
  }

  /** The replacement of a regex match: the query's own `$1` expansion, with the case rule on top. */
  private regexReplacement(from: number, to: number): string {
    const q = this.query;
    const m = this.view.state.sliceDoc(from, to);
    const r = new RegExp(q.search, q.caseSensitive ? "" : "i").exec(m);
    const out = r ? q.replace.replace(/\$([$&\d])/g, (_x, c: string) => (c === "$" ? "$" : c === "&" ? r[0] : (r[Number(c)] ?? ""))) : q.replace;
    return this.preserveOn ? preserveCase(m, out) : out;
  }

  private excludeCurrent(): void {
    const sel = this.view.state.selection.main;
    if (this.matches().some((m) => m.from === sel.from && m.to === sel.to)) this.excluded.add(sel.from);
    this.step(true);
  }

  private syncToggles(): void {
    this.toggles.case.classList.toggle("on", this.query.caseSensitive);
    this.toggles.word.classList.toggle("on", this.query.wholeWord);
    this.toggles.regexp.classList.toggle("on", this.query.regexp);
    this.clear.style.visibility = this.searchInput.value ? "visible" : "hidden";
  }

  private updateCount(): void {
    const q = this.query;
    this.dom.classList.toggle("no-match", false);
    if (!q.search || !q.valid) {
      this.count.textContent = q.search && !q.valid ? "Invalid regex" : "";
      this.dom.classList.toggle("no-match", !!q.search && !q.valid);
      return;
    }
    const sel = this.view.state.selection.main;
    let total = 0;
    let cur = 0;
    const cursor = q.getCursor(this.view.state);
    for (let r = cursor.next(); !r.done && total < 10000; r = cursor.next()) {
      total++;
      if (r.value.from === sel.from && r.value.to === sel.to) cur = total;
    }
    if (total === 0) {
      this.count.textContent = "No results";
      this.dom.classList.add("no-match");
    } else this.count.textContent = cur ? `${cur}/${total}` : `${total} result${total === 1 ? "" : "s"}`;
  }

  update(u: ViewUpdate): void {
    for (const tr of u.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery)) {
          const q = e.value as SearchQuery;
          if (!q.eq(this.query)) {
            this.query = q;
            this.searchInput.value = q.search;
            this.replaceInput.value = q.replace;
          }
        }
      }
    }
    if (u.docChanged) this.excluded.clear();
    this.syncToggles();
    this.updateCount();
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    } else if (e.key === "Enter" && e.shiftKey && mod && (e.target === this.searchInput || e.target === this.replaceInput)) {
      e.preventDefault();
      this.insertNewline(e.target as HTMLInputElement);
    } else if (e.key === "Enter" && e.target === this.searchInput) {
      e.preventDefault();
      this.step(!e.shiftKey);
    } else if (e.key === "Enter" && e.target === this.replaceInput) {
      e.preventDefault();
      if (mod && e.altKey) this.replaceEvery();
      else this.replaceOne();
    } else if (e.altKey && !mod && e.key.toLowerCase() === "c") {
      e.preventDefault();
      this.toggle("case");
    } else if (e.altKey && !mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      this.toggle("word");
    } else if (e.altKey && !mod && e.key.toLowerCase() === "x") {
      e.preventDefault();
      this.toggle("regexp");
    } else if (e.key === "F3") {
      e.preventDefault();
      this.step(!e.shiftKey);
    }
  }
}

function seedFromSelection(view: EditorView): void {
  const sel = view.state.selection.main;
  if (!sel.empty && view.state.doc.lineAt(sel.from).number === view.state.doc.lineAt(sel.to).number) {
    const q = getSearchQuery(view.state);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: view.state.sliceDoc(sel.from, sel.to), replace: q.replace, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp, test: scopeTest(scopeMode) })) as StateEffect<unknown> });
  }
}

export const openFind: Command = (view) => {
  wantReplace = false;
  if (searchPanelOpen(view.state)) {
    const panel = view.dom.querySelector<HTMLElement>(".cm-find");
    panel?.querySelector<HTMLElement>(".cm-find-replace")?.style.setProperty("display", "none");
    const inp = panel?.querySelector<HTMLInputElement>("input[name=search]");
    seedFromSelection(view);
    inp?.focus();
    inp?.select();
    return true;
  }
  seedFromSelection(view);
  return openSearchPanel(view);
};

export const openReplace: Command = (view) => {
  if (view.state.readOnly) return openFind(view);
  wantReplace = true;
  if (searchPanelOpen(view.state)) {
    const panel = view.dom.querySelector<HTMLElement>(".cm-find");
    panel?.querySelector<HTMLElement>(".cm-find-replace")?.style.removeProperty("display");
    const inp = panel?.querySelector<HTMLInputElement>("input[name=replace]");
    inp?.focus();
    inp?.select();
    return true;
  }
  seedFromSelection(view);
  return openSearchPanel(view);
};

export function sqlSearch(): Extension {
  return [
    search({ top: true, createPanel: (view) => new FindPanel(view) }),
    keymap.of([
      { key: "Mod-f", run: openFind, preventDefault: true },
      { key: "Mod-r", run: openReplace, preventDefault: true },
      { key: "F3", run: findNext, shift: findPrevious, preventDefault: true },
      { key: "Escape", run: (v) => (searchPanelOpen(v.state) ? closeSearchPanel(v) : false) },
    ]),
  ];
}

