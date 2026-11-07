import { Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { introspect, type TreeNode } from "../../api/db";
import { Icon, TextField, tip } from "../../components/ui";
import { SchemaFilterTree, type SchemaTreeGroup } from "./SchemaFilterTree";
import { withConnection } from "./remote";
import { type SchemaFilter, type SchemaItem, filterOrDefault, pathKey, parsePatternText, patternText, serializeFilter } from "./schemaModel";
import type { Session } from "./session";

const byName = (a: SchemaItem, b: SchemaItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export function SchemasTab(props: { s: Session }) {
  const s = props.s;
  const d = () => s.current()!;
  const [groups, setGroups] = createSignal<SchemaTreeGroup[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [filterText, setFilterText] = createSignal("");
  const [typed, setTyped] = createSignal<string | null>(null);

  const canLoad = () => !!d().id && !s.isModified(d());

  async function load() {
    const id = d().id;
    if (!id) return;
    setLoading(true);
    setErr(null);
    const driver = d().form.dbms;
    const dbName = d().form.database;
    const user = d().form.user;
    try {
      const tree = await withConnection(id, async () => {
        const items = (nodes: TreeNode[]): SchemaItem[] =>
          nodes
            .filter((n) => n.kind === "schema")
            .map((n) => ({
              path: n.path,
              name: n.name,
              system: !!n.extra.system,
              isDefault: driver === "postgres" ? !!n.extra.default : driver === "sqlite" ? n.name === "main" : driver === "oracle" ? n.name === user.toUpperCase() : n.name === dbName,
            }))
            .sort(byName);
        const top = await introspect(id, [], true);
        // PostgreSQL: only the database the data source is connected to can be introspected
        if (driver !== "postgres") return [{ name: null, items: items(top) }];
        const out: SchemaTreeGroup[] = [];
        for (const n of top.filter((x) => x.kind === "database" && (x.hasChildren || x.extra.current))) {
          try {
            out.push({ name: n.name, items: items(await introspect(id, n.path, true)) });
          } catch {
            /* a database we cannot read is left out */
          }
        }
        return out;
      });
      setGroups(tree);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  // load when the tab opens (and when another data source is selected)
  createEffect(
    on(
      () => d().key,
      () => {
        setGroups(null);
        setFilterText("");
        setCollapsed(new Set<string>());
        if (untrack(canLoad)) void load();
      },
    ),
  );

  const items = createMemo(() => (groups() ?? []).flatMap((g) => g.items));
  /** The draft's filter (Apply stores it in the UI state). */
  const filter = createMemo<SchemaFilter>(() => filterOrDefault(d().form.options.visibleSchemas, items()));
  const write = (f: SchemaFilter) => s.setOption("visibleSchemas", serializeFilter(f, items()));
  const dbKeys = () => (groups() ?? []).filter((g) => g.name).map((g) => pathKey([g.name!]));

  return (
    <div class="ds-schemas">
      <div class="ds-schemas-toolbar">
        <button type="button" class="dg-action-button ds-tb" disabled={!canLoad() || loading()} onClick={() => void load()} {...tip("Refresh")}>
          <Icon name="refresh" />
        </button>
        <button type="button" class="dg-action-button ds-tb" onClick={() => setCollapsed(new Set())} {...tip("Expand All")}>
          <Icon name="expand-all" />
        </button>
        <button type="button" class="dg-action-button ds-tb" onClick={() => setCollapsed(new Set(dbKeys()))} {...tip("Collapse All")}>
          <Icon name="collapse-all" />
        </button>
        <div class="ds-schemas-search">
          <TextField value={filterText()} onInput={setFilterText} prefix={<Icon name="search" />} />
        </div>
      </div>

      <div class="ds-schemas-tree">
        <Show when={groups()} fallback={<SchemasPlaceholder s={s} loading={loading()} err={err()} canLoad={canLoad()} load={load} />}>
          {(g) => (
            <SchemaFilterTree
              groups={g()}
              filter={filter()}
              onChange={write}
              collapsed={collapsed()}
              onToggleCollapse={(k) =>
                setCollapsed((c) => {
                  const n = new Set(c);
                  n.has(k) ? n.delete(k) : n.add(k);
                  return n;
                })
              }
              query={filterText()}
            />
          )}
        </Show>
      </div>

      <div class="ds-schemas-fields">
        <div class="ds-schemas-field">
          <span class="ds-label">Schema pattern:</span>
          <TextField
            // the text being typed stays as typed; it is rewritten from the filter (`db:schema`) when the field loses the focus
            value={typed() ?? (serializeFilter(filter(), items()) === undefined ? "" : patternText(filter(), items()))}
            disabled={!groups()}
            placeholder="postgres:public,sales,!temp*"
            frameClass="ds-fill"
            onInput={(v) => {
              setTyped(v);
              write(parsePatternText(v, items(), filter()));
            }}
            onBlur={() => setTyped(null)}
          />
        </div>
        <div class="ds-schemas-field">
          <span class="ds-label">Object filter:</span>
          <TextField
            value={filter().objects}
            disabled={!groups()}
            placeholder="Table and view names, e.g. tmp_*, !audit*"
            frameClass="ds-fill"
            onInput={(v) => write({ ...filter(), objects: v })}
          />
        </div>
      </div>
    </div>
  );
}

function SchemasPlaceholder(props: { s: Session; loading: boolean; err: string | null; canLoad: boolean; load: () => Promise<void> }) {
  return (
    <div class="ds-schemas-empty">
      <Show when={props.loading}>
        <span>Loading schemas…</span>
      </Show>
      <Show when={!props.loading && props.err}>
        <span class="ds-error-text">{props.err}</span>
      </Show>
      <Show when={!props.loading && !props.err && !props.canLoad}>
        <span>
          The data source has unapplied changes.{" "}
          <button
            type="button"
            class="ds-link"
            onClick={async () => {
              if (await props.s.apply()) void props.load();
            }}
          >
            Apply and load schemas
          </button>
        </span>
      </Show>
    </div>
  );
}
