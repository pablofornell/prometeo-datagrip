/**
 * Compare view (`editor.view.schemadiff`): the difference tree of schema A (left) against schema B (right), the DDL of
 * the selected object on both sides, and "Generate migration script", which opens a console of B's data source with
 * the SQL that makes B like A. The models are read when the tab opens (Refresh reads them again).
 */
import { For, Show, createEffect, createMemo, createSignal, on, onMount, type JSX, untrack } from "solid-js";
import { type SchemaModel, createConsole, getDdl, schemaModel, writeConsole } from "../../api/db";
import { ActionButton, Checkbox, ComboBox, Icon, type ComboOption, notify, tip } from "../../components/ui";
import type { EditorTab } from "../../state/tabs";
import { ensureConnected, explorerDataSources, openConsoleTab } from "../explorer";
import { errText } from "../table/ds";
import { DEFAULT_DIFF_OPTIONS, type DiffFilter, type DiffNode, type DiffOptions, diffSchemas, filterDiff, summarize, visibleRows } from "./diff";
import { type MigrationOptions, planCounts, planMigration, renderMigration, tableDdlKey, tablesToCreate } from "./migration";
import { FILTERS, FILTER_LABEL, type SchemaRef, allIds, changeText, objectRefOf, owningObject, routineOf, summaryText } from "./model";
import "./schema-diff.css";

interface CompareTabData {
  left?: SchemaRef;
  right?: SchemaRef;
}

const MARK: Record<DiffNode["status"], string> = { same: "", onlyA: "A", onlyB: "B", changed: "≠" };
const MARK_TITLE: Record<DiffNode["status"], string> = { same: "", onlyA: "Only in A", onlyB: "Only in B", changed: "Changed" };

export function SchemaDiffView(props: { tab: EditorTab; active: boolean }): JSX.Element {
  const data = props.tab.data as CompareTabData | undefined;
  if (!data?.left || !data?.right) return <div class="sd-view"><div class="sd-overlay">This comparison has no schemas.</div></div>;
  return <Compare left={data.left} right={data.right} />;
}

function Compare(props: { left: SchemaRef; right: SchemaRef }): JSX.Element {
  const [a, setA] = createSignal<SchemaModel | undefined>(undefined);
  const [b, setB] = createSignal<SchemaModel | undefined>(undefined);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [filter, setFilter] = createSignal<DiffFilter>("all");
  const [opts, setOpts] = createSignal<DiffOptions>(DEFAULT_DIFF_OPTIONS);
  const [includeDrops, setIncludeDrops] = createSignal(false);
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = createSignal("schema");
  const [ddlA, setDdlA] = createSignal("");
  const [ddlB, setDdlB] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let ddlSeq = 0;

  const dsName = (id: string): string => explorerDataSources().find((d) => d.id === id)?.name ?? id;
  const labelA = () => `${props.left.schema} [${dsName(props.left.dsId)}]`;
  const labelB = () => `${props.right.schema} [${dsName(props.right.dsId)}]`;

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([ensureConnected(props.left.dsId), ensureConnected(props.right.dsId)]);
      const [ma, mb] = await Promise.all([schemaModel(props.left.dsId, props.left.schema), schemaModel(props.right.dsId, props.right.schema)]);
      setA(ma);
      setB(mb);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void load());

  const root = createMemo(() => {
    const ma = a();
    const mb = b();
    return ma && mb ? diffSchemas(ma, mb, opts()) : undefined;
  });
  const summary = createMemo(() => {
    const r = root();
    return r ? summarize(r) : undefined;
  });
  const shown = createMemo(() => {
    const r = root();
    return r ? filterDiff(r, filter()) : undefined;
  });
  /** A flat filter view shows every row open; the full tree keeps the rows the user opened. */
  const rows = createMemo(() => {
    const s = shown();
    if (!s) return [];
    return visibleRows(s, filter() === "all" ? expanded() : new Set(allIds(s)));
  });
  const selectedObject = createMemo(() => {
    const r = root();
    return r ? owningObject(r, selected()) : undefined;
  });

  /** The DDL of the selected object on both sides (the owning table for a column, key, index, ...). */
  const loadDdl = async () => {
    // untracked: the DDL follows the selection and the models, not the diff options
    const obj = untrack(selectedObject);
    const ma = untrack(a);
    const mb = untrack(b);
    if (!obj || !ma || !mb) {
      setDdlA("");
      setDdlB("");
      return;
    }
    const mine = ++ddlSeq;
    const side = async (which: "left" | "right"): Promise<string> => {
      const model = which === "left" ? ma : mb;
      const ref = objectRefOf(obj, which, model.schema, obj.kind === "routine" ? routineOf(model.routines, obj) : undefined);
      if (!ref) return "";
      const ds = which === "left" ? props.left.dsId : props.right.dsId;
      try {
        return await getDdl(ds, ref, true);
      } catch (e) {
        return `-- ${errText(e)}`;
      }
    };
    const [x, y] = await Promise.all([side("left"), side("right")]);
    if (mine === ddlSeq) {
      setDdlA(x);
      setDdlB(y);
    }
  };
  createEffect(on([() => selectedObject()?.id, a, b], () => void loadDdl(), { defer: true }));

  const toggle = (id: string) => {
    const next = new Set(expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const patchOpts = (p: Partial<DiffOptions>) => setOpts((o) => ({ ...o, ...p }));

  /** Reads the DDL of the tables only in A, writes the migration script and opens it in a console of B. */
  const generate = async () => {
    const ma = a();
    const mb = b();
    if (!ma || !mb || busy()) return;
    setBusy(true);
    try {
      const ddl = new Map<string, string>();
      for (const name of tablesToCreate(ma, mb)) {
        ddl.set(tableDdlKey(name), await getDdl(props.left.dsId, { schema: ma.schema, name, kind: "table" }, true));
      }
      const migration: MigrationOptions = { includeDrops: includeDrops() };
      const plan = planMigration(ma, mb, opts(), ddl);
      const counts = planCounts(plan, migration);
      if (counts.total === 0 && plan.notes.length === 0) {
        notify({ kind: "info", title: "Nothing to migrate", body: `${labelB()} is already like ${labelA()}.` });
        return;
      }
      const text = renderMigration(plan, migration, { from: labelA(), to: labelB() });
      const name = await createConsole(props.right.dsId);
      await writeConsole(props.right.dsId, name, text);
      openConsoleTab(props.right.dsId, name);
      notify({
        kind: "success",
        title: "Migration script",
        body: `${counts.active} statements to run, ${counts.commented} drops commented out${plan.notes.length ? `, ${plan.notes.length} notes for you` : ""}.`,
        timeout: 10000,
      });
    } catch (e) {
      notify({ kind: "error", title: "Cannot generate the migration script", body: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const filterOptions = (): ComboOption<DiffFilter>[] => FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f] }));
  const dropsTip = "DROP statements are commented out unless this is checked: objects that exist only in B are not removed by accident.";

  return (
    <div class="sd-view">
      <div class="sd-toolbar">
        <ActionButton icon="refresh" title="Read both schemas again" onClick={() => void load()} disabled={loading()} />
        <div class="sd-filter">
          <ComboBox options={filterOptions()} value={filter()} onChange={setFilter} width={150} />
        </div>
        <Checkbox label="Ignore column order" checked={opts().ignoreColumnOrder} onChange={(v) => patchOpts({ ignoreColumnOrder: v })} />
        <Checkbox
          label="Ignore constraint names"
          checked={opts().ignoreConstraintNames}
          onChange={(v) => patchOpts({ ignoreConstraintNames: v })}
        />
        <span class="sd-spacer" />
        <span class="sd-title" title={`A: ${labelA()}   B: ${labelB()}`}>
          A: {labelA()} · B: {labelB()}
        </span>
        <span {...tip(dropsTip)}>
          <Checkbox label="Include drops" checked={includeDrops()} onChange={setIncludeDrops} />
        </span>
        <button type="button" class="sd-generate" disabled={!a() || !b() || busy()} onClick={() => void generate()}>
          Generate migration script
        </button>
      </div>
      <Show when={error()}>
        <div class="sd-overlay sd-error" role="alert">
          {error()}
        </div>
      </Show>
      <Show when={loading() && !error()}>
        <div class="sd-overlay">Reading both schemas...</div>
      </Show>
      <Show when={summary()}>
        {(s) => (
          <div class="sd-summary">
            {summaryText(s())} <span class="sd-hint">· B is changed to match A by the migration script</span>
          </div>
        )}
      </Show>
      <div class="sd-tree" role="tree" aria-label="Differences">
        <For each={rows()} fallback={<Show when={root()}><div class="sd-empty">Nothing to show for this filter.</div></Show>}>
          {(row) => {
            const n = () => row.node;
            const open = () => (filter() === "all" ? expanded().has(n().id) : true);
            return (
              <div
                class={`sd-row sd-${n().status}${selected() === n().id ? " sd-selected" : ""}`}
                role="treeitem"
                aria-selected={selected() === n().id}
                aria-expanded={n().children.length ? open() : undefined}
                style={{ "padding-left": `${6 + row.depth * 16}px` }}
                onClick={() => setSelected(n().id)}
              >
                <Show when={n().children.length > 0} fallback={<span class="sd-caret" />}>
                  <button
                    type="button"
                    class="sd-caret"
                    tabindex={-1}
                    disabled={filter() !== "all"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(n().id);
                    }}
                  >
                    {open() ? "▾" : "▸"}
                  </button>
                </Show>
                <span class="sd-mark" title={MARK_TITLE[n().status]}>
                  {MARK[n().status]}
                </span>
                <span class="sd-name">{n().name}</span>
                <span class="sd-kind">{n().kind}</span>
                <span class="sd-change">{changeText(n())}</span>
              </div>
            );
          }}
        </For>
      </div>
      <div class="sd-ddl">
        <div class="sd-ddl-pane">
          <div class="sd-ddl-head">
            <Icon name="dg/schema" size={14} /> A: {labelA()}
          </div>
          <pre class="sd-ddl-text">{ddlA() || (selectedObject() ? "(not in A)" : "Select an object of the tree.")}</pre>
        </div>
        <div class="sd-ddl-pane">
          <div class="sd-ddl-head">
            <Icon name="dg/schema" size={14} /> B: {labelB()}
          </div>
          <pre class="sd-ddl-text">{ddlB() || (selectedObject() ? "(not in B)" : "")}</pre>
        </div>
      </div>
    </div>
  );
}

