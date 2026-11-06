import { For, Show, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { introspect, type TreeNode } from "../../api/db";
import { Checkbox, Icon, TextField, tip } from "../../components/ui";
import { withConnection } from "./remote";
import { pathKey, visibleSchemas } from "./schemas";
import type { Session } from "./session";

interface Node {
  path: string[];
  name: string;
  /** Schema / database leaf or a PG database with schema children. */
  children: Node[] | null;
}

export function SchemasTab(props: { s: Session }) {
  const s = props.s;
  const d = () => s.current()!;
  const [nodes, setNodes] = createSignal<Node[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [filter, setFilter] = createSignal("");

  const canLoad = () => !!d().id && !s.isModified(d());

  async function load() {
    const id = d().id;
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const tree = await withConnection(id, async () => {
        // PostgreSQL: only the database the data source is connected to can be introspected
        const mk = async (n: TreeNode): Promise<Node | null> => {
          if (n.kind !== "database") return { path: n.path, name: n.name, children: null };
          try {
            const kids = (await introspect(id, n.path)).filter((c) => c.kind === "schema");
            return { path: n.path, name: n.name, children: kids.map((c) => ({ path: c.path, name: c.name, children: null })) };
          } catch {
            return null;
          }
        };
        const top = await introspect(id, []);
        return (await Promise.all(top.filter((n) => n.kind === "database" || n.kind === "schema").map(mk))).filter((n): n is Node => n !== null);
      });
      setNodes(tree);
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
        setNodes(null);
        setFilter("");
        setCollapsed(new Set<string>());
        if (untrack(canLoad)) void load();
      },
    ),
  );

  const leaves = createMemo(() => {
    const out: string[][] = [];
    for (const n of nodes() ?? []) {
      if (n.children) for (const c of n.children) out.push(c.path);
      else out.push(n.path);
    }
    return out;
  });
  const sel = createMemo(() => {
    const v = visibleSchemas(d().form);
    return v ? new Set(v.map(pathKey)) : null; // null = all
  });
  const isOn = (path: string[]) => sel() === null || sel()!.has(pathKey(path));

  function write(next: Set<string>) {
    const all = leaves();
    if (all.every((p) => next.has(pathKey(p)))) s.setOption("visibleSchemas", undefined);
    else s.setOption("visibleSchemas", JSON.stringify(all.filter((p) => next.has(pathKey(p)))));
  }
  function toggle(paths: string[][], on: boolean) {
    const cur = new Set(leaves().filter(isOn).map(pathKey));
    for (const p of paths) on ? cur.add(pathKey(p)) : cur.delete(pathKey(p));
    write(cur);
  }
  const state = (paths: string[][]) => {
    const n = paths.filter(isOn).length;
    return { checked: n > 0 && n === paths.length, partial: n > 0 && n < paths.length };
  };

  const matches = (n: Node) => {
    const q = filter().trim().toLowerCase();
    if (!q) return true;
    return n.name.toLowerCase().includes(q) || !!n.children?.some((c) => c.name.toLowerCase().includes(q));
  };

  const toggleCollapse = (n: Node) =>
    setCollapsed((c) => {
      const next = new Set(c);
      const k = pathKey(n.path);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  return (
    <div class="ds-schemas">
      <div class="ds-schemas-toolbar">
        <button type="button" class="dg-action-button ds-tb" disabled={!canLoad() || loading()} onClick={() => void load()} {...tip("Refresh")}>
          <Icon name="refresh" />
        </button>
        <button type="button" class="dg-action-button ds-tb" onClick={() => setCollapsed(new Set())} {...tip("Expand All")}>
          <Icon name="expand-all" />
        </button>
        <button
          type="button"
          class="dg-action-button ds-tb"
          onClick={() => setCollapsed(new Set((nodes() ?? []).filter((n) => n.children).map((n) => pathKey(n.path))))}
          {...tip("Collapse All")}
        >
          <Icon name="collapse-all" />
        </button>
        <div class="ds-schemas-search">
          <TextField value={filter()} onInput={setFilter} prefix={<Icon name="search" />} />
        </div>
      </div>

      <div class="ds-schemas-tree">
        <Show when={nodes()} fallback={<SchemasPlaceholder s={s} loading={loading()} err={err()} canLoad={canLoad()} load={load} />}>
          <div class="ds-tree-row">
            <span class="ds-tree-gap" />
            <Checkbox
              checked={state(leaves()).checked}
              indeterminate={state(leaves()).partial}
              onChange={(c) => toggle(leaves(), c)}
              label="All schemas"
            />
          </div>
          <For each={nodes()!.filter(matches)}>
            {(n) => (
              <>
                <div class="ds-tree-row">
                  <Show when={n.children} fallback={<span class="ds-tree-gap" />}>
                    <span class="ds-tree-chevron" onClick={() => toggleCollapse(n)}>
                      <Icon name={collapsed().has(pathKey(n.path)) ? "chevron-right" : "chevron-down"} />
                    </span>
                  </Show>
                  <Checkbox
                    checked={state(n.children ? n.children.map((c) => c.path) : [n.path]).checked}
                    indeterminate={state(n.children ? n.children.map((c) => c.path) : [n.path]).partial}
                    onChange={(c) => toggle(n.children ? n.children.map((x) => x.path) : [n.path], c)}
                    label={n.name}
                  />
                </div>
                <Show when={n.children && !collapsed().has(pathKey(n.path))}>
                  <For each={n.children!.filter((c) => matches(n) || matches({ ...c, children: null }))}>
                    {(c) => (
                      <div class="ds-tree-row ds-tree-child">
                        <span class="ds-tree-gap" />
                        <Checkbox checked={isOn(c.path)} onChange={(on) => toggle([c.path], on)} label={c.name} />
                      </div>
                    )}
                  </For>
                </Show>
              </>
            )}
          </For>
        </Show>
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
