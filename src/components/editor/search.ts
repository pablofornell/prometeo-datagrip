import { type Extension, type StateEffect } from "@codemirror/state";
import { type Command, type EditorView, type Panel, type ViewUpdate, keymap, runScopeHandlers } from "@codemirror/view";
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
  setSearchQuery,
} from "@codemirror/search";

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

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private searchInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private count: HTMLElement;
  private toggles: Record<"case" | "word" | "regexp", HTMLButtonElement>;
  private replaceRow: HTMLElement;
  private query: SearchQuery;

  constructor(readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const root = document.createElement("div");
    root.className = "cm-find";
    root.addEventListener("keydown", (e) => this.keydown(e));

    const row = document.createElement("div");
    row.className = "cm-find-row";
    const field = document.createElement("div");
    field.className = "cm-find-field";
    field.append(img("search"));
    this.searchInput = document.createElement("input");
    this.searchInput.className = "cm-find-input";
    this.searchInput.name = "search";
    this.searchInput.placeholder = "Search";
    this.searchInput.spellcheck = false;
    this.searchInput.setAttribute("main-field", "true");
    this.searchInput.value = this.query.search;
    this.searchInput.addEventListener("input", () => this.commit());
    this.toggles = {
      case: button("cm-find-toggle", "Match Case (Alt+C)", img("match-case")),
      word: button("cm-find-toggle", "Words (Alt+W)", img("exact-words")),
      regexp: button("cm-find-toggle", "Regex (Alt+X)", img("regex")),
    };
    for (const [k, b] of Object.entries(this.toggles)) {
      b.addEventListener("click", () => {
        this.toggle(k as "case" | "word" | "regexp");
      });
    }
    field.append(this.searchInput, this.toggles.case, this.toggles.word, this.toggles.regexp);
    this.count = document.createElement("span");
    this.count.className = "cm-find-count";
    const prev = button("cm-find-btn", "Previous Occurrence (Shift+F3)", img("chevron-up"));
    prev.addEventListener("click", () => findPrevious(view));
    const next = button("cm-find-btn", "Next Occurrence (F3)", img("chevron-down"));
    next.addEventListener("click", () => findNext(view));
    const close = button("cm-find-btn cm-find-close", "Close (Escape)", img("close"));
    close.addEventListener("click", () => {
      closeSearchPanel(view);
      view.focus();
    });
    row.append(field, this.count, prev, next, close);

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "cm-find-row cm-find-replace";
    const rfield = document.createElement("div");
    rfield.className = "cm-find-field";
    rfield.append(img("edit"));
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "cm-find-input";
    this.replaceInput.name = "replace";
    this.replaceInput.placeholder = "Replace";
    this.replaceInput.spellcheck = false;
    this.replaceInput.value = this.query.replace;
    this.replaceInput.addEventListener("input", () => this.commit());
    rfield.append(this.replaceInput);
    const rep = button("cm-find-text-btn", "Replace (Enter)", "Replace");
    rep.addEventListener("click", () => replaceNext(view));
    const repAll = button("cm-find-text-btn", "Replace All (Ctrl+Alt+Enter)", "Replace all");
    repAll.addEventListener("click", () => replaceAll(view));
    this.replaceRow.append(rfield, rep, repAll);

    root.append(row, this.replaceRow);
    this.dom = root;
    this.syncToggles();
    this.showReplace(wantReplace && !view.state.readOnly);
    this.updateCount();
  }

  mount(): void {
    (wantReplace && !this.view.state.readOnly ? this.replaceInput : this.searchInput).focus();
    this.searchInput.select();
  }

  showReplace(on: boolean): void {
    this.replaceRow.style.display = on ? "" : "none";
  }

  private toggle(k: "case" | "word" | "regexp"): void {
    const q = this.query;
    this.setQuery(
      new SearchQuery({
        search: q.search,
        replace: q.replace,
        caseSensitive: k === "case" ? !q.caseSensitive : q.caseSensitive,
        wholeWord: k === "word" ? !q.wholeWord : q.wholeWord,
        regexp: k === "regexp" ? !q.regexp : q.regexp,
      }),
    );
  }

  private commit(): void {
    const q = this.query;
    this.setQuery(
      new SearchQuery({
        search: this.searchInput.value,
        replace: this.replaceInput.value,
        caseSensitive: q.caseSensitive,
        wholeWord: q.wholeWord,
        regexp: q.regexp,
      }),
    );
  }

  private setQuery(q: SearchQuery): void {
    if (!q.eq(this.query)) {
      this.query = q;
      this.view.dispatch({ effects: setSearchQuery.of(q) as StateEffect<unknown> });
    }
  }

  private syncToggles(): void {
    this.toggles.case.classList.toggle("on", this.query.caseSensitive);
    this.toggles.word.classList.toggle("on", this.query.wholeWord);
    this.toggles.regexp.classList.toggle("on", this.query.regexp);
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
      closeSearchPanel(this.view);
      this.view.focus();
    } else if (e.key === "Enter" && e.target === this.searchInput) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.key === "Enter" && e.target === this.replaceInput) {
      e.preventDefault();
      if (mod && e.altKey) replaceAll(this.view);
      else replaceNext(this.view);
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
      (e.shiftKey ? findPrevious : findNext)(this.view);
    }
  }
}

function seedFromSelection(view: EditorView): void {
  const sel = view.state.selection.main;
  if (!sel.empty && view.state.doc.lineAt(sel.from).number === view.state.doc.lineAt(sel.to).number) {
    const q = getSearchQuery(view.state);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: view.state.sliceDoc(sel.from, sel.to), replace: q.replace, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp })) as StateEffect<unknown> });
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

