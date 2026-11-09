import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { appInfo } from "../../api/db";
import { Dialog, Icon, Tabs, TextField, notify, openMenu, tip } from "../../components/ui";
import type { MenuItem } from "../../components/ui";
import { AdvancedTab } from "./AdvancedTab";
import { DriversPage } from "./DriversPage";
import { GeneralTab } from "./GeneralTab";
import { OptionsTab } from "./OptionsTab";
import { SchemasTab } from "./SchemasTab";
import { SshSslTab } from "./SshSslTab";
import { TestBar } from "./TestBar";
import { DBMS, DBMS_ORDER, type Dbms, dbmsIcon, driversRailIcon } from "./drivers";
import { dsFolders, dsGroupOf } from "../../state/ds-folders";
import { emitDataSourcesChanged } from "./events";
import { passwordStorageWarning } from "./passwordStorage";
import { type Session, createSession } from "./session";
import { describeImport, exportDataSources, importDataSourcesFromClipboard, importDataSourcesFromFile } from "./transfer";
import type { UrlPrefill } from "./urlParse";
import { ColorSelect, LinkButton } from "./widgets";

export interface DialogApi {
  select(id: string): void;
  addNew(dbms: Dbms, prefill?: UrlPrefill): void;
  /** Shows the Drivers page. */
  showDrivers(): void;
}

export interface DialogProps {
  selectId?: string;
  newDbms?: Dbms;
  /** Fields of the new data source ("Data Source from URL"). */
  newPrefill?: UrlPrefill;
  /** Start on the Drivers page. */
  drivers?: boolean;
  onClose: () => void;
  register: (api: DialogApi | null) => void;
}

type TabId = "general" | "options" | "ssh" | "schemas" | "advanced";
const TABS: { id: TabId; title: string }[] = [
  { id: "general", title: "General" },
  { id: "options", title: "Options" },
  { id: "ssh", title: "SSH/SSL" },
  { id: "schemas", title: "Schemas" },
  { id: "advanced", title: "Advanced" },
];

const Arrow = (props: { dir: "left" | "right" }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
    {props.dir === "left" ? <path d="M13 8H3M7 4L3 8l4 4" /> : <path d="M3 8h10M9 4l4 4-4 4" />}
  </svg>
);

export function DataSourceDialog(props: DialogProps) {
  const s = createSession();
  const [page, setPage] = createSignal<"sources" | "drivers">(props.drivers ? "drivers" : "sources");
  const [tab, setTab] = createSignal<TabId>("general");
  const [commentOpen, setCommentOpen] = createSignal(false);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  /** The driver the Drivers page selects when it opens (the one of the data source whose gear button was pressed). */
  const [driverFocus, setDriverFocus] = createSignal<Dbms | undefined>(undefined);

  onMount(async () => {
    await s.load(props.selectId);
    if (props.newDbms) s.addNew(props.newDbms, props.newPrefill);
    focusName();
    props.register({
      select: (id) => {
        setPage("sources");
        const d = s.drafts.find((x) => x.id === id);
        if (d) s.select(d.key);
      },
      addNew: (dbms, prefill) => {
        setPage("sources");
        s.addNew(dbms, prefill);
        focusName();
      },
      showDrivers: () => (setDriverFocus(undefined), setPage("drivers")),
    });
  });

  const focusName = () =>
    setTimeout(() => {
      // the user may already be typing in another field (fast input right after opening): never steal the focus
      const cur = document.activeElement as HTMLElement | null;
      if (cur?.closest(".ds-root") && cur.matches("input, textarea") && !cur.closest(".ds-name-field")) return;
      const el = document.querySelector<HTMLInputElement>(".ds-name-field input:not([type=color])");
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }, 0);

  // when the focused element disappears (tab / page switch) key events land on <body>, outside the dialog frame
  const onWindowKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.target !== document.body) return;
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) void ok();
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onWindowKey);
  onCleanup(() => window.removeEventListener("keydown", onWindowKey));

  const close = () => {
    props.register(null);
    props.onClose();
  };
  const ok = async () => {
    if (!s.hasChanges() || (await s.apply())) close();
  };
  const apply = async () => {
    if (s.hasChanges()) await s.apply();
  };

  let addBtn!: HTMLButtonElement;
  const openAdd = () =>
    openMenu(
      DBMS_ORDER.map<MenuItem>((id) => ({ label: DBMS[id].label, icon: dbmsIcon(id), run: () => { s.addNew(id); focusName(); } })),
      { anchor: addBtn, compact: true, minWidth: 160 },
    );

  let moreBtn!: HTMLButtonElement;
  const [info] = createResource(() => appInfo().catch(() => undefined));
  /** Plain-text password storage (the OS keyring is not reachable): shown in the footer. */
  const storageWarning = () =>
    passwordStorageWarning(info()?.passwordStorage, s.drafts.some((x) => x.saved?.hasPassword && x.saved.passwordStorage === "file"), info()?.configDir);

  /** Export and import work on the saved data sources: pending edits would be lost by the reload an import does. */
  const savedOnly = (what: string): boolean => {
    if (!s.hasChanges()) return true;
    notify({ title: what, body: "Apply or cancel the pending changes first: this works on the saved data sources.", kind: "info" });
    return false;
  };
  const failed = (title: string, e: unknown) => notify({ title, body: String(e), kind: "error" });
  const doExport = async (ids?: string[]) => {
    if (!savedOnly("Export Data Sources")) return;
    try {
      const r = await exportDataSources(ids);
      if (r) notify({ title: "Data sources exported", body: `${r.count} data source${r.count === 1 ? "" : "s"} written to ${r.path}. Passwords are not included.`, kind: "info" });
    } catch (e) {
      failed("Cannot export the data sources", e);
    }
  };
  const doImport = async (from: "file" | "clipboard") => {
    if (!savedOnly("Import Data Sources")) return;
    try {
      const summary = from === "file" ? await importDataSourcesFromFile() : await importDataSourcesFromClipboard();
      if (!summary) return;
      const r = describeImport(summary);
      notify({ title: r.title, body: r.body, kind: r.kind });
      if (summary.imported.length) {
        await s.load(summary.imported[0].id);
        emitDataSourcesChanged();
      }
    } catch (e) {
      failed("Cannot import the data sources", e);
    }
  };
  const openMore = () =>
    openMenu(
      [
        { label: "Import Data Sources from File…", run: () => void doImport("file") },
        { label: "Import Data Sources from Clipboard", run: () => void doImport("clipboard") },
        { type: "separator" },
        { label: "Export Data Sources…", run: () => void doExport() },
        { label: "Export Selected Data Source…", enabled: !!d()?.id, run: () => void doExport(d()?.id ? [d()!.id!] : undefined) },
      ],
      { anchor: moreBtn, compact: true, minWidth: 200 },
    );

  const d = () => s.current();

  const onListKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const i = s.drafts.findIndex((x) => x.key === s.selectedKey());
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = s.drafts[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) s.select(n.key);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      s.removeSelected();
    } else if (e.key === "F2" && d()) {
      setRenaming(d()!.key);
    } else if (e.key === "Insert") {
      openAdd();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  /** The list: the data sources outside any folder under "Project Data Sources", then one group per folder. */
  const groups = createMemo(() => {
    const folder = (x: (typeof s.drafts)[number]) => (x.id ? dsGroupOf(x.id) : undefined);
    const out = [{ title: "Project Data Sources", drafts: s.drafts.filter((x) => !folder(x)) }];
    for (const f of dsFolders()) {
      const drafts = s.drafts.filter((x) => folder(x) === f);
      if (drafts.length) out.push({ title: f, drafts });
    }
    return out;
  });
  const modifiedTab = createMemo(() => (page() === "sources" ? tab() : "general"));

  return (
    <Dialog
      title="Data Sources and Drivers"
      width={1000}
      height={758}
      flush
      onClose={close}
      footerLeft={
        <Show when={s.error()} fallback={<Show when={storageWarning()}>{(w) => <span class="ds-footer-warning" title={w()}>{w()}</span>}</Show>}>
          <span class="ds-footer-error">{s.error()}</span>
        </Show>
      }
      buttons={[
        { label: "OK", primary: true, run: () => void ok() },
        { label: "Cancel", run: close },
        { label: "Apply", disabled: !s.hasChanges() || s.applying(), run: () => void apply() },
      ]}
    >
      {/* the kit Dialog cancels every mousedown (keeps focus in place), which also stops text fields from being focused by a click */}
      <div class="ds-root" onMouseDown={(e) => (e.target as HTMLElement).closest("input, textarea") && e.stopPropagation()}>
        {/* ---- icon rail */}
        <div class="ds-rail">
          <button type="button" class="ds-rail-btn" classList={{ "ds-selected": page() === "sources" }} {...tip("Data Sources")} onClick={() => setPage("sources")}>
            <Icon name="dg/dbms" />
          </button>
          <button type="button" class="ds-rail-btn" classList={{ "ds-selected": page() === "drivers" }} {...tip("Drivers")} onClick={() => setPage("drivers")}>
            <Icon src={driversRailIcon()} />
          </button>
        </div>

        <Show
          when={page() === "sources"}
          fallback={
            <DriversPage
              initial={driverFocus()}
              onCreate={(dbms) => {
                setPage("sources");
                s.addNew(dbms);
                focusName();
              }}
            />
          }
        >
          {/* ---- left: list */}
          <div class="ds-left">
            <div class="ds-left-head">
              <span class="ds-left-title">Data Sources</span>
              <span class="ds-left-nav">
                <button type="button" class="ds-nav" disabled={!s.canBack()} onClick={() => s.navigate(-1)}>
                  <Arrow dir="left" />
                </button>
                <button type="button" class="ds-nav" disabled={!s.canForward()} onClick={() => s.navigate(1)}>
                  <Arrow dir="right" />
                </button>
              </span>
            </div>
            <div class="ds-left-toolbar">
              <button type="button" ref={addBtn} class="dg-action-button ds-tb" {...tip("Add")} onClick={openAdd}>
                <Icon name="add" />
                <span class="dg-action-button-arrow" />
              </button>
              <button type="button" class="dg-action-button ds-tb" classList={{ "dg-disabled": !d() }} {...tip("Remove")} disabled={!d()} onClick={() => s.removeSelected()}>
                <Icon name="remove" />
              </button>
              <button type="button" class="dg-action-button ds-tb" classList={{ "dg-disabled": !d() }} {...tip("Duplicate")} disabled={!d()} onClick={() => s.duplicateSelected()}>
                <Icon name="copy" />
              </button>
              <button
                type="button"
                class="dg-action-button ds-tb"
                classList={{ "dg-disabled": !d() }}
                {...tip("Go to Driver")}
                disabled={!d()}
                onClick={() => {
                  setDriverFocus(d()!.form.dbms);
                  setPage("drivers");
                }}
              >
                <Icon name="settings" />
              </button>
              <button type="button" ref={moreBtn} class="dg-action-button ds-tb" {...tip("Import / Export Data Sources")} onClick={openMore}>
                <Icon name="more-horizontal" />
              </button>
            </div>
            <div class="ds-list" tabindex={0} onKeyDown={onListKey}>
              <For each={groups()}>
                {(g) => (
                  <>
                    <div class="ds-list-group">{g.title}</div>
                    <For each={g.drafts}>
                      {(x) => (
                        <div
                          class="ds-list-row"
                          classList={{ "ds-selected": s.selectedKey() === x.key, "ds-new": s.isNew(x), "ds-modified": s.isModified(x) }}
                          onClick={() => s.select(x.key)}
                          onDblClick={() => setRenaming(x.key)}
                        >
                          <Icon src={dbmsIcon(x.form.dbms)} />
                          <Show when={renaming() === x.key} fallback={<span class="ds-list-name">{x.form.name || "<unnamed>"}</span>}>
                            <input
                              class="ds-rename"
                              spellcheck={false}
                              value={x.form.name}
                              ref={(el) => setTimeout(() => (el.focus(), el.select()), 0)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  s.rename(x.key, e.currentTarget.value);
                                  setRenaming(null);
                                } else if (e.key === "Escape") {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  setRenaming(null);
                                }
                              }}
                              onBlur={(e) => {
                                if (renaming() === x.key) s.rename(x.key, e.currentTarget.value);
                                setRenaming(null);
                              }}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </For>
              <hr class="ds-list-sep" />
              <div class="ds-list-row ds-problems">
                <span class="ds-list-name">Problems</span>
                <Show when={s.problems().length}>
                  <span class="ds-badge">{s.problems().length}</span>
                </Show>
              </div>
              <For each={s.problems()}>
                {(p) => (
                  <div
                    class="ds-list-row ds-problem"
                    title={p.message}
                    onClick={() => {
                      s.select(p.key);
                      setTab(p.tab);
                    }}
                  >
                    <span class="ds-list-name">
                      {p.dsName}: {p.message}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>

          {/* ---- right: details */}
          <div class="ds-right">
            <Show
              when={d()}
              fallback={<div class="ds-empty">No data source selected. Press + to create one.</div>}
            >
              <div class="ds-name-row">
                <span class="ds-label ds-name-label">Name:</span>
                <TextField
                  value={d()!.form.name}
                  onInput={(v) => s.setField("name", v)}
                  frameClass="ds-name-field ds-fill"
                  data-autofocus
                  suffix={<ColorSelect value={d()!.form.color} onChange={(c) => s.setField("color", c)} />}
                />
                <LinkButton class="ds-add-comment" onClick={() => setCommentOpen(!commentOpen())}>
                  {commentOpen() || d()!.form.options.comment ? "Comment" : "Add comment"}
                </LinkButton>
              </div>
              <Show when={commentOpen() || d()!.form.options.comment}>
                <div class="ds-comment-row">
                  <span class="ds-label ds-name-label">Comment:</span>
                  <TextField
                    value={d()!.form.options.comment ?? ""}
                    onInput={(v) => s.setOption("comment", v)}
                    frameClass="ds-fill"
                  />
                </div>
              </Show>
              <div class="ds-tabbar">
                <Tabs
                  variant="dialog"
                  items={TABS}
                  active={modifiedTab()}
                  onSelect={(id) => setTab(id as TabId)}
                />
              </div>
              <div class="ds-tabbody">
                <Show when={tab() === "general"}>
                  <GeneralTab s={s} />
                </Show>
                <Show when={tab() === "options"}>
                  <OptionsTab s={s} />
                </Show>
                <Show when={tab() === "ssh"}>
                  <SshSslTab s={s} />
                </Show>
                <Show when={tab() === "schemas"}>
                  <SchemasTab s={s} />
                </Show>
                <Show when={tab() === "advanced"}>
                  <AdvancedTab s={s} />
                </Show>
              </div>
              <TestBar s={s} tab={tab()} />
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}

export type { Session };
