/**
 * State of one open "Data Sources and Drivers" dialog: the drafts of every data source, selection,
 * pending deletes and the Apply logic. Everything stays in memory until Apply / OK.
 */
import { confirmEndTransactions } from "../console/txguard";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { friendlyConnectionError } from "../../state/connection-errors";
import { copyDataSourcePassword, deleteDataSource, listDataSources, saveDataSource, testConnection } from "../../api/db";
import type { DataSource, DataSourceConfig } from "../../api/db";
import { forgetVisibleSchemas } from "../../state/schema-filter";
import { forgetDsGroup } from "../../state/ds-folders";
import { saveVisibleSchemas } from "./schemas";
import { DBMS, type Dbms, buildUrl, parseUrl, sqliteFileOfUrl } from "./drivers";
import type { UrlPrefill } from "./urlParse";
import {
  type Draft,
  type Form,
  type TestInfo,
  type Problem,
  autoName,
  configFromForm,
  reconnectsOnApply,
  savedPart,
  defaultForm,
  formFromDataSource,
  normalizedForm,
  uniqueName,
  validate,
} from "./model";
import { emitDataSourcesChanged, emitDataSourcesCreated } from "./events";

let keySeq = 0;
const newKey = () => `ds-${++keySeq}`;

const snapshot = (f: Form) => JSON.stringify(normalizedForm(f));

function draftFromSaved(ds: DataSource): Draft {
  const form = formFromDataSource(ds);
  return {
    key: newKey(),
    id: ds.id,
    saved: ds,
    form,
    password: { value: "", touched: false },
    nameAuto: false,
    base: snapshot(form),
    test: { state: "idle" },
  };
}

export interface SessionProblem extends Problem {
  key: string;
  dsName: string;
}

export function createSession() {
  const [drafts, setDrafts] = createStore<Draft[]>([]);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [deletedIds, setDeletedIds] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<{ list: string[]; pos: number }>({ list: [], pos: -1 });

  const indexOf = (key: string | null) => (key == null ? -1 : drafts.findIndex((d) => d.key === key));
  const current = createMemo(() => drafts[indexOf(selectedKey())] as Draft | undefined);

  // ---- selection (with back / forward history)
  function select(key: string | null, record = true) {
    batch(() => {
      setSelectedKey(key);
      setError(null);
      if (record && key) {
        setHistory((h) => {
          const list = h.list.slice(0, h.pos + 1);
          if (list[list.length - 1] !== key) list.push(key);
          return { list, pos: list.length - 1 };
        });
      }
    });
  }
  const canBack = () => history().pos > 0;
  const canForward = () => history().pos < history().list.length - 1;
  function navigate(dir: -1 | 1) {
    const h = history();
    let p = h.pos + dir;
    while (p >= 0 && p < h.list.length && indexOf(h.list[p]) < 0) p += dir; // skip removed ones
    if (p < 0 || p >= h.list.length) return;
    setHistory({ ...h, pos: p });
    select(h.list[p], false);
  }

  // ---- load
  async function load(selectId?: string) {
    let list: DataSource[] = [];
    try {
      list = await listDataSources();
    } catch (e) {
      setError(String(e));
    }
    batch(() => {
      setDrafts(list.map(draftFromSaved));
      setLoading(false);
      const d = drafts.find((x) => x.id === selectId) ?? drafts[0];
      select(d?.key ?? null);
    });
  }

  // ---- derived state
  const isNew = (d: Draft) => d.id == null;
  const isModified = (d: Draft) => d.id != null && (snapshot(d.form) !== d.base || d.password.touched);
  /** Saving reaches the backend (the schema filter alone is a UI-state setting and does not). */
  const needsSave = (d: Draft) => d.id != null && (savedPart(snapshot(d.form)) !== savedPart(d.base) || d.password.touched);
  /** Saving reconnects the data source (name / color / schema filter do not): open transactions would be lost. */
  const reconnects = (d: Draft) => d.id != null && (reconnectsOnApply(d.form, d.id, d.saved) || d.password.touched);
  const hasChanges = () => deletedIds().length > 0 || drafts.some((d) => isNew(d) || isModified(d));

  const problems = createMemo<SessionProblem[]>(() => {
    const out: SessionProblem[] = [];
    for (const d of drafts) {
      const others = drafts.filter((x) => x.key !== d.key).map((x) => x.form.name.trim());
      for (const p of validate(d.form, others)) out.push({ ...p, key: d.key, dsName: d.form.name || "<unnamed>" });
    }
    return out;
  });

  // ---- editing
  /** Re-derive the URL / name after a field of `drafts[i].form` changed. */
  function derive(i: number, opts: { url?: boolean; name?: boolean } = { url: true, name: true }) {
    const d = drafts[i];
    if (opts.url !== false && d.form.connType === "default") setDrafts(i, "form", "url", buildUrl(d.form.dbms, d.form));
    if (opts.name !== false && d.nameAuto) {
      const taken = drafts.filter((x) => x.key !== d.key).map((x) => x.form.name);
      setDrafts(i, "form", "name", uniqueName(autoName(d.form), taken));
    }
  }

  function setField<K extends keyof Form>(key: K, value: Form[K]) {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    batch(() => {
      setDrafts(i, "form", key, value as never);
      if (key === "name") {
        setDrafts(i, "nameAuto", false);
      } else {
        derive(i);
      }
    });
  }

  /** Inline rename in the list (also turns the automatic naming off). */
  function rename(key: string, name: string) {
    const i = indexOf(key);
    if (i < 0 || !name.trim()) return;
    batch(() => {
      setDrafts(i, "form", "name", name.trim());
      setDrafts(i, "nameAuto", false);
    });
  }

  function setOption(key: string, value: string | undefined) {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    setDrafts(i, "form", "options", key, value === undefined || value === "" ? (undefined as never) : value);
  }

  /** Free-form option row (Advanced tab): rename a key keeping its value. */
  function renameOption(from: string, to: string) {
    const i = indexOf(selectedKey());
    if (i < 0 || from === to) return;
    setDrafts(
      i,
      "form",
      "options",
      produce((o: Record<string, string>) => {
        const v = o[from];
        delete o[from];
        if (to) o[to] = v ?? "";
      }),
    );
  }

  function setPassword(value: string) {
    const i = indexOf(selectedKey());
    if (i >= 0) setDrafts(i, "password", { value, touched: true });
  }

  function setUrl(text: string) {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    const d = drafts[i];
    batch(() => {
      setDrafts(i, "form", "url", text);
      if (d.form.connType !== "default") return;
      const dbms = d.form.dbms;
      const p = parseUrl(dbms, text);
      if (!p) return;
      if (p.query || p.user) {
        // parameters cannot be represented by the fields: keep the URL as the source of truth
        setDrafts(i, "form", "connType", "url");
        return;
      }
      if (dbms === "sqlite") setDrafts(i, "form", "file", sqliteFileOfUrl(text) ?? "");
      else setDrafts(i, "form", { host: p.host, port: p.port, database: p.database });
      if (dbms === "oracle") setOption("oracleConnType", p.sid ? "sid" : undefined);
      derive(i, { url: false });
    });
  }

  function setConnType(t: Form["connType"]) {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    batch(() => {
      const d = drafts[i];
      if (t === d.form.connType) return;
      setDrafts(i, "form", "connType", t);
      if (t === "memory") setDrafts(i, "form", "url", "jdbc:sqlite::memory:");
      else if (t === "default") derive(i);
      else if (d.form.connType === "memory") setDrafts(i, "form", "url", buildUrl(d.form.dbms, d.form));
      derive(i, { url: false });
    });
  }

  /** Oracle's "Connection type" combo: Service name / SID (the default fields) or URL only. */
  function setOracleConnType(t: "service" | "sid" | "url") {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    batch(() => {
      if (t === "url") {
        setDrafts(i, "form", "connType", "url");
        return;
      }
      setDrafts(i, "form", "connType", "default");
      setOption("oracleConnType", t === "sid" ? "sid" : undefined);
      derive(i);
    });
  }

  function setDbms(dbms: Dbms) {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    const d = drafts[i];
    const old = DBMS[d.form.dbms];
    const info = DBMS[dbms];
    if (old.id === dbms) return;
    batch(() => {
      const f = d.form;
      const patch: Partial<Form> = { dbms };
      if (dbms === "sqlite") {
        patch.connType = f.connType === "url" ? "url" : "default";
      } else {
        patch.host = f.host || "localhost";
        patch.port = !f.port || f.port === String(old.defaultPort) ? String(info.defaultPort) : f.port;
        if (f.connType === "memory") patch.connType = "default";
        if (dbms === "postgres" && !f.database) patch.database = "postgres";
        if (old.id === "postgres" && f.database === "postgres") patch.database = "";
        if (old.id === "oracle" || dbms === "oracle") patch.database = dbms === "postgres" ? "postgres" : dbms === "oracle" ? "XE" : "";
      }
      setDrafts(i, "form", patch);
      const mode = f.options.sslmode;
      if (mode && !info.sslModes.some((m) => m.value === mode)) setDrafts(i, "form", "options", "sslmode", undefined as never);
      if (dbms === "sqlite") setDrafts(i, "form", "options", "sslmode", undefined as never);
      if (dbms !== "sqlite") setDrafts(i, "form", "options", "create", undefined as never);
      if (dbms !== "oracle") setDrafts(i, "form", "options", "oracleConnType", undefined as never);
      if (dbms === "oracle") setDrafts(i, "form", "auth", "password");
      if (d.form.connType === "url") setDrafts(i, "form", "url", buildUrl(dbms, d.form));
      derive(i);
      setDrafts(i, "test", { state: "idle" });
    });
  }

  // ---- list operations
  function addNew(dbms: Dbms, prefill?: UrlPrefill) {
    const form = defaultForm(dbms);
    if (prefill) {
      // "Data Source from URL": the parsed fields replace the defaults
      if (prefill.host !== undefined) form.host = prefill.host;
      if (prefill.port) form.port = prefill.port;
      if (prefill.database !== undefined) form.database = prefill.database;
      if (prefill.user) form.user = prefill.user;
      if (prefill.file) form.file = prefill.file;
      if (prefill.oracleConnType === "sid") form.options.oracleConnType = "sid";
      form.url = buildUrl(dbms, form);
    }
    const taken = drafts.map((d) => d.form.name);
    form.name = uniqueName(autoName(form), taken);
    const d: Draft = {
      key: newKey(),
      id: null,
      saved: null,
      form,
      password: prefill?.password ? { value: prefill.password, touched: true } : { value: "", touched: false },
      nameAuto: true,
      base: snapshot(form),
      test: { state: "idle" },
    };
    batch(() => {
      setDrafts(drafts.length, d);
      select(d.key);
    });
  }

  function removeSelected() {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    const d = drafts[i];
    batch(() => {
      if (d.id) setDeletedIds((l) => [...l, d.id!]);
      const next = drafts[i + 1] ?? drafts[i - 1];
      setDrafts((l) => l.filter((x) => x.key !== d.key));
      select(next?.key ?? null);
    });
  }

  function duplicateSelected() {
    const d = current();
    if (!d) return;
    const copy = structuredClone(unwrap(d)) as Draft;
    copy.key = newKey();
    copy.id = null;
    copy.saved = null;
    copy.nameAuto = false;
    copy.form.name = uniqueName(d.form.name, drafts.map((x) => x.form.name));
    // the stored password cannot be read back: a copy of a saved source takes it over on the backend when applied
    copy.password = d.password.touched ? { ...d.password } : { value: "", touched: false };
    copy.passwordFrom = d.password.touched ? null : (d.passwordFrom ?? (d.saved?.hasPassword ? d.id : null));
    copy.base = snapshot(copy.form);
    copy.test = { state: "idle" };
    const at = indexOf(d.key) + 1;
    batch(() => {
      setDrafts(produce((l: Draft[]) => void l.splice(at, 0, copy)));
      select(copy.key);
    });
  }

  // ---- test connection
  async function test(): Promise<void> {
    const i = indexOf(selectedKey());
    if (i < 0) return;
    const d = drafts[i];
    const key = d.key;
    // a malformed host / port / URL would fail with a confusing message: report it as a validation problem
    const bad = validate(d.form, []).find((p) => !p.message.startsWith("Name"));
    if (bad) {
      setError(bad.message);
      return;
    }
    setError(null);
    const cfg: Partial<DataSourceConfig> = { ...configFromForm(d.form, d.id, d.saved), password: passwordToSend(d) };
    // a duplicate that was not applied yet: the backend looks the password up by the id of the original
    if (d.passwordFrom && !d.id && cfg.password == null && d.form.auth === "password" && d.form.connType !== "url") cfg.id = d.passwordFrom;
    const sslmode = d.form.options.sslmode ?? null;
    const dbms = d.form.dbms;
    const target = { driver: dbms, host: d.form.host, port: d.form.port, file: d.form.file };
    setDrafts(i, "test", "state", "running");
    let info: TestInfo;
    try {
      const r = await testConnection(cfg);
      info = {
        ok: r.ok,
        version: r.serverVersion,
        message: r.ok ? r.message : friendlyConnectionError(r.message, target),
        elapsedMs: r.elapsedMs,
        sslmode,
        // the backend reports the negotiated state when it knows it (`TestResult.ssl`)
        ssl: (r as { ssl?: boolean | null }).ssl ?? null,
        dbms,
      };
    } catch (e) {
      info = { ok: false, version: null, message: friendlyConnectionError(String(e), target), elapsedMs: 0, sslmode, ssl: null, dbms };
    }
    const j = indexOf(key);
    if (j < 0) return;
    // produce() assigns (a plain setter would merge the new result into the old object, which `lastOk` shares)
    setDrafts(
      j,
      "test",
      produce((x) => {
        x.state = "done";
        x.info = { ...info };
        if (info.ok) x.lastOk = { ...info };
      }),
    );
  }

  function passwordToSend(d: Draft): string | null {
    if (d.form.connType === "url") return null; // credentials travel inside the URL
    if (d.form.auth === "none") return d.saved?.hasPassword || d.password.touched ? "" : null;
    return d.password.touched ? d.password.value : null;
  }

  // ---- apply
  /** Saves everything. Returns false (and selects the offending source) when something is invalid. */
  async function apply(): Promise<boolean> {
    const first = problems()[0];
    if (first) {
      batch(() => {
        select(first.key);
        setError(first.message);
      });
      return false;
    }
    // Saving a changed connection reconnects an existing data source, and removing closes it: ask before open
    // transactions are lost. A changed schema filter is not a connection change: nothing to ask.
    const affected = [
      ...deletedIds(),
      ...drafts.filter((d) => reconnects(d) && d.id).map((d) => d.id as string),
    ];
    for (const dsId of affected) {
      if (!(await confirmEndTransactions({ dsId, reason: "reconnecting with the new settings" }))) return false;
    }
    setApplying(true);
    try {
      for (const id of deletedIds()) {
        await deleteDataSource(id);
        forgetVisibleSchemas(id);
        forgetDsGroup(id);
      }
      setDeletedIds([]);
      const keys = drafts.filter((d) => isNew(d) || isModified(d)).map((d) => d.key);
      const created: string[] = [];
      for (const key of keys) {
        const i = indexOf(key);
        const d = drafts[i];
        const wasNew = isNew(d);
        let saved: DataSource;
        if (d.id != null && d.saved && !needsSave(d)) {
          // only the schema filter changed: a UI-state write, the backend (and its connection) is left alone
          saved = d.saved;
        } else {
          const cfg = { ...configFromForm(d.form, d.id, d.saved), password: passwordToSend(d) } as Partial<DataSourceConfig> & { name: string };
          saved = await saveDataSource(cfg);
          if (wasNew && d.passwordFrom && cfg.password == null && d.form.auth === "password" && d.form.connType !== "url") {
            saved = await copyDataSourcePassword(d.passwordFrom, saved.id).catch(() => saved);
          }
        }
        saveVisibleSchemas(saved.id, d.form.options.visibleSchemas);
        if (wasNew) created.push(saved.id);
        const j = indexOf(key);
        if (j < 0) continue;
        batch(() => {
          setDrafts(j, { id: saved.id, saved, password: { value: "", touched: false }, nameAuto: false });
          // keep what the user typed; only the baseline for the modified marker moves
          setDrafts(j, "base", snapshot(drafts[j].form));
        });
      }
      setError(null);
      emitDataSourcesChanged();
      if (created.length) emitDataSourcesCreated(created);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setApplying(false);
    }
  }

  return {
    drafts,
    current,
    selectedKey,
    select,
    canBack,
    canForward,
    navigate,
    loading,
    applying,
    error,
    setError,
    load,
    isNew,
    isModified,
    hasChanges,
    problems,
    setField,
    rename,
    setOption,
    renameOption,
    setPassword,
    setUrl,
    setConnType,
    setOracleConnType,
    setDbms,
    addNew,
    removeSelected,
    duplicateSelected,
    test,
    apply,
    indexOf,
  };
}

export type Session = ReturnType<typeof createSession>;
