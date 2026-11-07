/**
 * Modify Table (Ctrl+F6) and New > Table: tree of columns / keys / foreign keys / indexes / checks on the left, the
 * property sheet of the selected node on the right and the live DDL preview below. OK runs the statements in one
 * session and reloads the table in the explorer. See `docs/ux/screens/104-*.png`, `105-*.png`.
 */
import { Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, untrack, type JSX } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { Checkbox, type MenuItem, Tree, type TreeController, type TreeItem, openMenu } from "../../components/ui";
import { createConsole, writeConsole } from "../../api/db";
import { type ColumnContext, columnIcon, iconOf } from "../explorer/model";
import { NodeIcon } from "../explorer/NodeIcon";
import { LOCAL } from "../explorer/icons";
import { openConsoleTab } from "../explorer/commands";
import { askChoice } from "../table/dialogs";
import { runPlan } from "./apply";
import { ColumnList, Choice, Field, Text, TypeCombo } from "./fields";
import { ArrowDown, ArrowUp, EditorFrame, TbButton } from "./Frame";
import { type EditorCtx, errText, loadColumnNames, loadTableNames } from "./load";
import {
  type ColumnDef,
  FK_ACTIONS,
  PG_INDEX_METHODS,
  type TableDef,
  TYPES,
  cloneTable,
  emptyTable,
  newCheck,
  newColumn,
  newFk,
  newIndex,
  newKey,
  newUid,
} from "./model";
import { alterTablePlan, createTablePlan, planText, validateTable } from "./sqlgen";
import { Icon } from "../../components/ui";

export interface TableEditorProps {
  ctx: EditorCtx;
  /** The loaded table (Modify); without it the dialog creates a table. */
  orig?: TableDef;
  /** Node to select first (Modify Column… on a column of the tree). */
  select?: { kind: "col" | "key" | "fk" | "idx" | "chk"; name: string };
  onClose: () => void;
  /** After the statements ran (the explorer reloads the schema). */
  onApplied: () => void;
}

type ListKey = "columns" | "keys" | "fks" | "indexes" | "checks";
const FOLDERS: { key: ListKey; label: string; id: string; prefix: string }[] = [
  { key: "columns", label: "columns", id: "f:columns", prefix: "col" },
  { key: "keys", label: "keys", id: "f:keys", prefix: "key" },
  { key: "fks", label: "foreign keys", id: "f:fks", prefix: "fk" },
  { key: "indexes", label: "indexes", id: "f:indexes", prefix: "idx" },
  { key: "checks", label: "checks", id: "f:checks", prefix: "chk" },
];

export function TableEditor(props: TableEditorProps): JSX.Element {
  const { ctx } = props;
  const d = ctx.driver;
  const create = !props.orig;
  const orig = props.orig;
  const initial = orig ? cloneTable(orig) : emptyTable(ctx.schema);
  const [cur, setCur] = createStore<TableDef>(initial);
  const initialJson = JSON.stringify(initial);
  const dirty = () => JSON.stringify(unwrap(cur)) !== initialJson;

  const [sel, setSel] = createSignal("root");
  const [history, setHistory] = createSignal<string[]>(["root"]);
  const [at, setAt] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [applyError, setApplyError] = createSignal("");
  let tree: TreeController | undefined;

  const plan = createMemo(() => (orig ? alterTablePlan(d, orig, cur) : createTablePlan(d, cur)));
  const problem = createMemo(() => validateTable(d, cur)[0] ?? plan().error);

  // ---------------------------------------------------------------- selection

  const parse = (id: string): { kind: string; uid: string } => {
    const i = id.indexOf(":");
    return i < 0 ? { kind: id, uid: "" } : { kind: id.slice(0, i), uid: id.slice(i + 1) };
  };
  const go = (id: string, focus = false): void => {
    if (id === sel()) return;
    const h = history().slice(0, at() + 1);
    h.push(id);
    setHistory(h);
    setAt(h.length - 1);
    setSel(id);
    if (focus) queueMicrotask(focusName);
  };
  const jump = (delta: number): void => {
    const i = at() + delta;
    if (i < 0 || i >= history().length) return;
    setAt(i);
    setSel(history()[i]);
  };
  const focusName = (): void => {
    const el = document.querySelector<HTMLInputElement>('.dgse-right input[data-name="1"]');
    if (el && document.activeElement !== el) {
      el.focus();
      el.select();
    }
  };

  const selected = createMemo(() => {
    const { kind, uid } = parse(sel());
    switch (kind) {
      case "col":
        return cur.columns.find((x) => x.uid === uid);
      case "key":
        return cur.keys.find((x) => x.uid === uid);
      case "fk":
        return cur.fks.find((x) => x.uid === uid);
      case "idx":
        return cur.indexes.find((x) => x.uid === uid);
      case "chk":
        return cur.checks.find((x) => x.uid === uid);
      default:
        return undefined;
    }
  });
  // an item that was removed: fall back to the table
  createEffect(() => {
    const { kind } = parse(sel());
    if (!["root", "f"].includes(kind) && !selected()) setSel("root");
  });

  // ---------------------------------------------------------------- tree

  const synthetic = (what: string, n: number): string => (d === "sqlite" ? `${what} #${n}` : "");
  const tbl = (s: string): string => s || "<unnamed>";
  const ctxIcons = (): ColumnContext => {
    const fk = new Set<string>();
    const uq = new Set<string>();
    const idx = new Set<string>();
    cur.fks.forEach((f) => f.columns.forEach((c) => fk.add(c)));
    cur.keys.filter((k) => !k.primary).forEach((k) => k.columns.forEach((c) => uq.add(c)));
    cur.indexes.forEach((i) => i.columns.forEach((c) => idx.add(c)));
    return { fk, uq, idx };
  };

  const roots = createMemo<TreeItem[]>(() => {
    const icons = ctxIcons();
    const pkCols = new Set(cur.keys.filter((k) => k.primary).flatMap((k) => k.columns));
    const fresh = (list: { uid: string }[] | undefined, uid: string): string | undefined => (!orig || !list?.some((x) => x.uid === uid) ? "dgse-new" : undefined);
    const columns: TreeItem[] = cur.columns.map((c) => ({
      id: "col:" + c.uid,
      labelClass: fresh(orig?.columns, c.uid),
      label: tbl(c.name),
      hint: [c.type, c.default && `= ${c.default.length > 20 ? c.default.slice(0, 18) + "…" : c.default}`].filter(Boolean).join(" "),
      data: columnIcon({ name: c.name, extra: { isPk: pkCols.has(c.name), nullable: !c.notNull } } as never, icons),
    }));
    const keys: TreeItem[] = cur.keys.map((k, i) => ({
      id: "key:" + k.uid,
      labelClass: fresh(orig?.keys, k.uid),
      label: k.name || synthetic("key", i + 1) || tbl(k.name),
      hint: `(${k.columns.join(", ")})`,
      data: iconOf(k.primary ? "primaryKey" : "uniqueKey"),
    }));
    const fks: TreeItem[] = cur.fks.map((f, i) => ({
      id: "fk:" + f.uid,
      labelClass: fresh(orig?.fks, f.uid),
      label: f.name || synthetic("foreign-key", i + 1) || tbl(f.name),
      hint: f.refTable ? `(${f.columns.join(", ")}) → ${f.refTable}` : `(${f.columns.join(", ")})`,
      data: iconOf("foreignKey"),
    }));
    const indexes: TreeItem[] = cur.indexes.map((x) => ({
      id: "idx:" + x.uid,
      labelClass: fresh(orig?.indexes, x.uid),
      label: tbl(x.name),
      hint: `(${x.columns.join(", ")})${x.unique ? " UNIQUE" : ""}`,
      data: iconOf("index", { extra: { unique: x.unique, primary: false } } as never),
    }));
    const checks: TreeItem[] = cur.checks.map((x, i) => ({
      id: "chk:" + x.uid,
      labelClass: fresh(orig?.checks, x.uid),
      label: x.name || synthetic("check", i + 1) || tbl(x.name),
      hint: x.expr.length > 26 ? `(${x.expr.slice(0, 22)}…)` : `(${x.expr})`,
      data: iconOf("check"),
    }));
    const lists: Record<ListKey, TreeItem[]> = { columns, keys, fks, indexes, checks };
    return [
      {
        id: "root",
        labelClass: orig ? undefined : "dgse-new",
        label: tbl(cur.name),
        hint: `${ctx.schema} [${ctx.dsName}]`,
        data: iconOf("table"),
        hasChildren: true,
        children: FOLDERS.map<TreeItem>((f) => ({
          id: f.id,
          label: f.label,
          hint: lists[f.key].length ? String(lists[f.key].length) : undefined,
          data: LOCAL + "object-group",
          hasChildren: lists[f.key].length > 0,
          children: lists[f.key],
        })),
      },
    ];
  });

  const renderLabel = (item: TreeItem): JSX.Element => (
    <>
      <NodeIcon name={item.data as string | undefined} class="dg-tree-icon" />
      <span class={"dg-tree-label" + (item.labelClass ? " " + item.labelClass : "")}>{item.label}</span>
      <Show when={item.hint}>
        <span class="dg-tree-hint" classList={{ "dgse-count": item.id.startsWith("f:") }}>
          {item.hint}
        </span>
      </Show>
    </>
  );

  // ---------------------------------------------------------------- editing operations

  const colOf = (uid: string) => cur.columns.find((c) => c.uid === uid);

  function rename(list: ListKey, uid: string, name: string): void {
    setCur(list, (x) => x.uid === uid, "name" as never, name as never);
  }

  function renameColumn(uid: string, name: string): void {
    const old = colOf(uid)?.name;
    setCur(
      produce((t) => {
        const c = t.columns.find((x) => x.uid === uid);
        if (!c) return;
        c.name = name;
        if (old === undefined || old === name) return;
        const swap = (l: string[]) => l.map((x) => (x === old ? name : x));
        t.keys.forEach((k) => (k.columns = swap(k.columns)));
        t.fks.forEach((f) => (f.columns = swap(f.columns)));
        t.indexes.forEach((i) => (i.columns = swap(i.columns)));
      }),
    );
  }

  function removeColumn(uid: string): void {
    const name = colOf(uid)?.name;
    setCur(
      produce((t) => {
        t.columns = t.columns.filter((c) => c.uid !== uid);
        if (!name) return;
        t.keys.forEach((k) => (k.columns = k.columns.filter((x) => x !== name)));
        t.keys = t.keys.filter((k) => k.columns.length > 0);
        t.indexes.forEach((i) => (i.columns = i.columns.filter((x) => x !== name)));
        t.indexes = t.indexes.filter((i) => i.columns.length > 0);
        t.fks = t.fks.filter((f) => !f.columns.includes(name));
      }),
    );
  }

  function add(kind: ListKey): void {
    const n = cur[kind].length + 1;
    let id = "";
    switch (kind) {
      case "columns": {
        const c = newColumn({ name: `column_${n}`, type: d === "sqlite" ? "" : d === "mysql" ? "int" : "integer" });
        setCur("columns", (l) => [...l, c]);
        id = "col:" + c.uid;
        break;
      }
      case "keys": {
        const k = newKey({ primary: !cur.keys.some((x) => x.primary) });
        setCur("keys", (l) => [...l, k]);
        id = "key:" + k.uid;
        break;
      }
      case "fks": {
        const f = newFk({ refSchema: ctx.schema });
        setCur("fks", (l) => [...l, f]);
        id = "fk:" + f.uid;
        break;
      }
      case "indexes": {
        const i = newIndex({ name: `${cur.name || "table"}_idx_${n}` });
        setCur("indexes", (l) => [...l, i]);
        id = "idx:" + i.uid;
        break;
      }
      case "checks": {
        const c = newCheck();
        setCur("checks", (l) => [...l, c]);
        id = "chk:" + c.uid;
        break;
      }
    }
    go(id, true);
  }

  function remove(): void {
    const { kind, uid } = parse(sel());
    const next = (list: { uid: string }[]) => {
      const i = list.findIndex((x) => x.uid === uid);
      const around = list[i + 1] ?? list[i - 1];
      return around ? { kind, uid: around.uid } : undefined;
    };
    let target: { kind: string; uid: string } | undefined;
    switch (kind) {
      case "col":
        target = next(cur.columns);
        removeColumn(uid);
        break;
      case "key":
        target = next(cur.keys);
        setCur("keys", (l) => l.filter((x) => x.uid !== uid));
        break;
      case "fk":
        target = next(cur.fks);
        setCur("fks", (l) => l.filter((x) => x.uid !== uid));
        break;
      case "idx":
        target = next(cur.indexes);
        setCur("indexes", (l) => l.filter((x) => x.uid !== uid));
        break;
      case "chk":
        target = next(cur.checks);
        setCur("checks", (l) => l.filter((x) => x.uid !== uid));
        break;
      default:
        return;
    }
    go(target ? `${target.kind}:${target.uid}` : "f:" + FOLDERS.find((f) => f.prefix === kind)!.key);
  }

  function duplicate(): void {
    const { kind, uid } = parse(sel());
    const copy = <T extends { uid: string; name: string }>(list: T[]): T | undefined => {
      const src = list.find((x) => x.uid === uid);
      return src ? { ...JSON.parse(JSON.stringify(src)), uid: newUid(), name: src.name ? `${src.name}_copy` : "" } : undefined;
    };
    let made: { uid: string } | undefined;
    switch (kind) {
      case "col":
        if ((made = copy(cur.columns))) setCur("columns", (l) => [...l, made as ColumnDef]);
        break;
      case "key":
        if ((made = copy(cur.keys))) setCur("keys", (l) => [...l, { ...(made as never as TableDef["keys"][number]), primary: false }]);
        break;
      case "fk":
        if ((made = copy(cur.fks))) setCur("fks", (l) => [...l, made as never]);
        break;
      case "idx":
        if ((made = copy(cur.indexes))) setCur("indexes", (l) => [...l, made as never]);
        break;
      case "chk":
        if ((made = copy(cur.checks))) setCur("checks", (l) => [...l, made as never]);
        break;
    }
    if (made) go(`${kind}:${made.uid}`, true);
  }

  function moveColumn(delta: -1 | 1): void {
    const { kind, uid } = parse(sel());
    if (kind !== "col") return;
    const i = cur.columns.findIndex((c) => c.uid === uid);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.columns.length) return;
    setCur(
      "columns",
      produce((l) => {
        [l[i], l[j]] = [l[j], l[i]];
      }),
    );
  }

  const canMove = (delta: -1 | 1): boolean => {
    const { kind, uid } = parse(sel());
    if (kind !== "col" || (!create && d !== "mysql")) return false;
    const i = cur.columns.findIndex((c) => c.uid === uid);
    return i + delta >= 0 && i + delta < cur.columns.length;
  };
  const isItem = (): boolean => !["root", "f"].includes(parse(sel()).kind);

  let addButton: HTMLButtonElement | undefined;
  const openAddMenu = (): void => {
    const folder = parse(sel());
    const current = folder.kind === "f" ? folder.uid : (FOLDERS.find((f) => f.prefix === folder.kind)?.key ?? "columns");
    const items: MenuItem[] = [
      { label: "Column", icon: "dg/column", run: () => add("columns") },
      { label: "Key", icon: "dg/grey-key", run: () => add("keys") },
      { label: "Foreign Key", icon: "dg/blue-key", run: () => add("fks") },
      { label: "Index", icon: "dg/index", run: () => add("indexes") },
      { label: "Check", icon: "dg/check-constraint", run: () => add("checks") },
    ];
    openMenu(items, { anchor: addButton, compact: true, minWidth: 150, selected: FOLDERS.findIndex((f) => f.key === current) });
  };

  // ---------------------------------------------------------------- finish

  async function ok(): Promise<void> {
    if (busy()) return;
    if (!create && !dirty()) return props.onClose();
    setBusy(true);
    setApplyError("");
    try {
      await runPlan(ctx.dsId, plan());
    } catch (e) {
      setApplyError(errText(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    props.onApplied();
    props.onClose();
  }

  async function cancel(): Promise<void> {
    if (dirty()) {
      const a = await askChoice({
        title: "Unsaved Changes",
        message: "You're about to lose your changes.",
        choices: [
          { label: "OK", value: "ok", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a !== "ok") return;
    }
    props.onClose();
  }

  async function toConsole(): Promise<void> {
    try {
      const name = await createConsole(ctx.dsId);
      await writeConsole(ctx.dsId, name, planText(plan()) + "\n");
      props.onClose();
      openConsoleTab(ctx.dsId, name);
    } catch (e) {
      setApplyError(errText(e));
    }
  }

  // preselect (Modify Column…)
  if (props.select && orig) {
    const list = { col: cur.columns, key: cur.keys, fk: cur.fks, idx: cur.indexes, chk: cur.checks }[props.select.kind] as { uid: string; name: string }[];
    const hit = list.find((x) => x.name === props.select!.name);
    if (hit) {
      setSel(`${props.select.kind}:${hit.uid}`);
      setHistory([`${props.select.kind}:${hit.uid}`]);
    }
  }

  // ---------------------------------------------------------------- property sheet

  const [targets] = createResource(() => loadTableNames(ctx));

  const sheet = (): JSX.Element => {
    const { kind, uid } = parse(sel());
    return (
      <Switch>
        <Match when={kind === "root"}>
          <Chip icon={iconOf("table")} label={cur.name} />
          <Field label="Name">
            <Text name value={cur.name} onInput={(v) => setCur("name", v)} error={!cur.name.trim()} />
          </Field>
          <Field label="Comment">
            <Text value={cur.comment} onInput={(v) => setCur("comment", v)} disabled={d === "sqlite"} />
          </Field>
          <Show when={d === "postgres"}>
            <Field label="Owner">
              <Text value={cur.owner} onInput={(v) => setCur("owner", v)} />
            </Field>
            <Field label="Tablespace">
              <Text value={cur.tablespace} onInput={(v) => setCur("tablespace", v)} disabled={!create} />
            </Field>
          </Show>
        </Match>
        <Match when={kind === "f"}>
          <div class="dgse-empty">{emptyText(uid as ListKey)}</div>
        </Match>
        <Match when={kind === "col" && colOf(uid)}>
          <ColumnSheet uid={uid} />
        </Match>
        <Match when={kind === "key"}>
          <KeySheet uid={uid} />
        </Match>
        <Match when={kind === "fk"}>
          <FkSheet uid={uid} />
        </Match>
        <Match when={kind === "idx"}>
          <IndexSheet uid={uid} />
        </Match>
        <Match when={kind === "chk"}>
          <CheckSheet uid={uid} />
        </Match>
      </Switch>
    );
  };

  const emptyText = (k: string): string => {
    const what = { columns: "column", keys: "key", fks: "foreign key", indexes: "index", checks: "check" }[k] ?? "item";
    return `Click + to add a ${what}.`;
  };

  const colNames = () => cur.columns.map((c) => c.name).filter(Boolean);
  const inOrig = (uid: string) => !!orig?.columns.some((c) => c.uid === uid);

  function ColumnSheet(p: { uid: string }): JSX.Element {
    const c = () => colOf(p.uid)!;
    const set = <K extends keyof ColumnDef>(k: K, v: ColumnDef[K]) => setCur("columns", (x) => x.uid === p.uid, k, v);
    const existing = () => inOrig(p.uid);
    const pkSingle = () => cur.keys.some((k) => k.primary && k.columns.length === 1 && k.columns[0] === c().name);
    return (
      <Show when={c()}>
        <Chip icon={columnIcon({ name: c().name, extra: { nullable: !c().notNull } } as never)} label={c().name} />
        <Field label="Name">
          <Text name value={c().name} onInput={(v) => renameColumn(p.uid, v)} error={!c().name.trim()} />
        </Field>
        <Field label="Comment">
          <Text value={c().comment} onInput={(v) => set("comment", v)} disabled={d === "sqlite"} />
        </Field>
        <Field label="Data Type">
          <TypeCombo value={c().type} options={TYPES[d]} onInput={(v) => set("type", v)} />
        </Field>
        <Field label="">
          <Checkbox checked={c().notNull} onChange={(v) => set("notNull", v)} label="Not Null" />
        </Field>
        <Field label="Default Expression">
          <Text mono value={c().default} onInput={(v) => set("default", v)} disabled={!!c().generated} />
        </Field>
        <Show when={d === "postgres"}>
          <Field label="Generated Always As">
            <Text mono value={c().generated === "?" ? "" : c().generated} onInput={(v) => set("generated", v)} disabled={existing() || !!c().identity} />
          </Field>
          <Field label="Identity">
            <Choice value={c().identity} options={["ALWAYS", "BY DEFAULT"]} allowEmpty width={160} onChange={(v) => set("identity", v as ColumnDef["identity"])} disabled={!!c().generated} />
          </Field>
        </Show>
        <Show when={d === "mysql"}>
          <Field label="Generated Always As">
            <Text mono value={c().generated === "?" ? "" : c().generated} onInput={(v) => set("generated", v)} disabled={existing()} />
          </Field>
          <Show when={c().generated}>
            <Field label="Storage">
              <Choice value={c().generatedStored ? "STORED" : "VIRTUAL"} options={["STORED", "VIRTUAL"]} width={160} onChange={(v) => set("generatedStored", v === "STORED")} disabled={existing()} />
            </Field>
          </Show>
          <Field label="">
            <Checkbox checked={c().autoIncrement} onChange={(v) => set("autoIncrement", v)} label="Auto Increment" />
          </Field>
          <Field label="On Update">
            <Text mono value={c().onUpdate} onInput={(v) => set("onUpdate", v)} placeholder="CURRENT_TIMESTAMP" />
          </Field>
        </Show>
        <Show when={d === "sqlite" && pkSingle()}>
          <Field label="">
            <Checkbox checked={c().autoIncrement} onChange={(v) => set("autoIncrement", v)} label="Autoincrement" />
          </Field>
        </Show>
      </Show>
    );
  }

  function KeySheet(p: { uid: string }): JSX.Element {
    const k = () => cur.keys.find((x) => x.uid === p.uid);
    return (
      <Show when={k()}>
        <Chip icon={iconOf(k()!.primary ? "primaryKey" : "uniqueKey")} label={k()!.name || "key"} />
        <Show when={d !== "sqlite" && !(d === "mysql" && k()!.primary)}>
          <Field label="Name">
            <Text name value={k()!.name} onInput={(v) => rename("keys", p.uid, v)} />
          </Field>
        </Show>
        <Field label="">
          <Checkbox
            checked={k()!.primary}
            onChange={(v) => {
              setCur("keys", (x) => x.uid === p.uid, "primary", v);
              // a table has one primary key: the previous one turns into a unique key
              if (v) setCur("keys", (x) => x.uid !== p.uid && x.primary, "primary", false);
            }}
            label="Primary Key"
          />
        </Field>
        <Field label="Columns" top>
          <ColumnList all={colNames()} value={k()!.columns} onChange={(v) => setCur("keys", (x) => x.uid === p.uid, "columns", v)} />
        </Field>
      </Show>
    );
  }

  function FkSheet(p: { uid: string }): JSX.Element {
    const f = () => cur.fks.find((x) => x.uid === p.uid);
    const self = () => f()?.refTable === cur.name || (!!orig && f()?.refTable === orig.name);
    const [targetCols] = createResource(
      () => ({ t: f()?.refTable, self: self() }),
      async ({ t, self }) => (!t ? [] : self ? colNames() : loadColumnNames(ctx, t)),
    );
    const names = () => [...new Set([...(targets() ?? []), cur.name].filter(Boolean))];
    const setF = (patch: Partial<TableDef["fks"][number]>) => setCur("fks", (x) => x.uid === p.uid, patch);
    return (
      <Show when={f()}>
        <Chip icon={iconOf("foreignKey")} label={f()!.name || synthetic("foreign-key", cur.fks.indexOf(f()!) + 1) || "foreign key"} />
        <Show when={d !== "sqlite"}>
          <Field label="Name">
            <Text name value={f()!.name} onInput={(v) => rename("fks", p.uid, v)} />
          </Field>
        </Show>
        <Field label="Target Table">
          <Choice
            value={f()!.refTable}
            options={names()}
            allowEmpty
            onChange={(v) => setF({ refTable: v, refSchema: f()!.refSchema || ctx.schema, refColumns: [] })}
          />
        </Field>
        <Field label="Columns" top>
          <ColumnList all={colNames()} value={f()!.columns} onChange={(v) => setF({ columns: v })} />
        </Field>
        <Field label="Target Columns" top>
          <ColumnList all={targetCols() ?? []} value={f()!.refColumns} onChange={(v) => setF({ refColumns: v })} disabled={!f()!.refTable} />
        </Field>
        <Field label="On Update">
          <Choice value={f()!.onUpdate || "NO ACTION"} options={[...FK_ACTIONS]} width={160} onChange={(v) => setF({ onUpdate: v })} />
        </Field>
        <Field label="On Delete">
          <Choice value={f()!.onDelete || "NO ACTION"} options={[...FK_ACTIONS]} width={160} onChange={(v) => setF({ onDelete: v })} />
        </Field>
      </Show>
    );
  }

  function IndexSheet(p: { uid: string }): JSX.Element {
    const i = () => cur.indexes.find((x) => x.uid === p.uid);
    const set = (patch: Partial<TableDef["indexes"][number]>) => setCur("indexes", (x) => x.uid === p.uid, patch);
    return (
      <Show when={i()}>
        <Chip icon={iconOf("index", { extra: { unique: i()!.unique, primary: false } } as never)} label={i()!.name} />
        <Field label="Name">
          <Text name value={i()!.name} onInput={(v) => rename("indexes", p.uid, v)} error={!i()!.name.trim()} disabled={i()!.locked} />
        </Field>
        <Field label="">
          <Checkbox checked={i()!.unique} onChange={(v) => set({ unique: v })} label="Unique" disabled={i()!.locked} />
        </Field>
        <Show when={d === "postgres"}>
          <Field label="Method">
            <Choice value={i()!.method || "btree"} options={PG_INDEX_METHODS} width={160} onChange={(v) => set({ method: v })} disabled={i()!.locked} />
          </Field>
        </Show>
        <Field label="Columns" top>
          <ColumnList all={colNames()} value={i()!.columns} onChange={(v) => set({ columns: v })} disabled={i()!.locked} />
        </Field>
        <Show when={i()!.locked}>
          <div class="dgse-note">This index has a condition or included columns: it can only be dropped here.</div>
        </Show>
      </Show>
    );
  }

  function CheckSheet(p: { uid: string }): JSX.Element {
    const c = () => cur.checks.find((x) => x.uid === p.uid);
    return (
      <Show when={c()}>
        <Chip icon={iconOf("check")} label={c()!.name || "check"} />
        <Show when={d !== "sqlite"}>
          <Field label="Name">
            <Text name value={c()!.name} onInput={(v) => rename("checks", p.uid, v)} />
          </Field>
        </Show>
        <Field label="Expression">
          <Text mono name={d === "sqlite"} value={c()!.expr} onInput={(v) => setCur("checks", (x) => x.uid === p.uid, "expr", v)} error={!c()!.expr.trim()} />
        </Field>
      </Show>
    );
  }

  // ---------------------------------------------------------------- render

  createEffect(
    on(sel, (id) => {
      untrack(() => {
        // only for selections that did not come from the tree (select + reveal rebuilds the rows under the pointer)
        if (tree && tree.selected()?.id !== id) tree.select(id, { reveal: true });
      });
    }),
  );

  return (
    <EditorFrame
      toolbar={
        <>
          <TbButton title="Add" onClick={openAddMenu} ref={(el) => (addButton = el)}>
            <Icon name="add" />
          </TbButton>
          <TbButton title="Remove" disabled={!isItem()} onClick={remove}>
            <Icon name="remove" />
          </TbButton>
          <TbButton title="Duplicate" disabled={!isItem()} onClick={duplicate}>
            <Icon name="copy" />
          </TbButton>
          <TbButton title="Move Up" disabled={!canMove(-1)} onClick={() => moveColumn(-1)}>
            <ArrowUp />
          </TbButton>
          <TbButton title="Move Down" disabled={!canMove(1)} onClick={() => moveColumn(1)}>
            <ArrowDown />
          </TbButton>
          <span class="dgse-tb-spacer" />
          <TbButton title="Back" disabled={at() <= 0} onClick={() => jump(-1)}>
            <Icon name="chevron-left" />
          </TbButton>
          <TbButton title="Forward" disabled={at() >= history().length - 1} onClick={() => jump(1)}>
            <Icon name="chevron-right" />
          </TbButton>
        </>
      }
      tree={
        <Tree
          class="dgse-tree"
          roots={roots()}
          selectedId={sel()}
          onSelect={(it) => it && go(it.id)}
          initialExpanded={["root", ...FOLDERS.map((f) => f.id)]}
          speedSearchField={false}
          renderLabel={renderLabel}
          ref={(c) => (tree = c)}
        />
      }
      sheet={<div class="dgse-sheet">{sheet()}</div>}
      preview={planText(plan())}
      dialect={d}
      unchanged={!create && plan().statements.length === 0}
      problem={problem()}
      warnings={plan().warnings}
      busy={busy()}
      applyError={applyError()}
      canOk={!problem()}
      onOk={() => void ok()}
      onCancel={() => void cancel()}
      onConsole={() => void toConsole()}
    />
  );
}

function Chip(props: { icon?: string; label: string }): JSX.Element {
  return (
    <div class="dgse-chip">
      <NodeIcon name={props.icon} />
      <span>{props.label || " "}</span>
    </div>
  );
}
