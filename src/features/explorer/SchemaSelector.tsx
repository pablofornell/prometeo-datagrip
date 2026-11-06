/**
 * Schema selector popup (click on the `1` / `2 of 4` badge of a data source or database node): a checklist of the
 * schemas that saves `options.visibleSchemas` (the key of Data Sources > Schemas) and refreshes the tree.
 * Enter or a click outside applies, Escape cancels.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { DataSource, TreeNode } from "../../api/db";
import { Checkbox, notify } from "../../components/ui";
import { pathKey, visibleSchemas } from "../datasource/schemas";
import { updateDataSource } from "./commands";
import { dsOf, rawIntrospect } from "./core";

export interface SchemaItem {
  path: string[];
  name: string;
  system: boolean;
}
export interface SchemaGroup {
  /** PostgreSQL database; null for MySQL / SQLite (the schemas hang off the data source). */
  name: string | null;
  items: SchemaItem[];
}

/** Every schema the server lists (system ones included), grouped by database for PostgreSQL. */
export async function loadSchemaGroups(ds: DataSource): Promise<SchemaGroup[]> {
  const toItems = (nodes: TreeNode[]): SchemaItem[] =>
    nodes.filter((n) => n.kind === "schema").map((n) => ({ path: n.path, name: n.name, system: !!n.extra.system }));
  const top = await rawIntrospect(ds.id, [], true);
  if (ds.driver !== "postgres") return [{ name: null, items: toItems(top) }];
  const dbs = top.filter((n) => n.kind === "database" && (n.hasChildren || n.extra.current));
  return Promise.all(dbs.map(async (d) => ({ name: d.name, items: toItems(await rawIntrospect(ds.id, d.path, true)) })));
}

/**
 * `options.visibleSchemas` for a set of checked schemas: undefined (key removed) when it is the default view
 * (every non-system schema), else the JSON list of the checked introspection paths.
 */
export function visibleSchemasOption(groups: SchemaGroup[], checked: ReadonlySet<string>): string | undefined {
  const all = groups.flatMap((g) => g.items);
  const isDefault = all.every((i) => checked.has(pathKey(i.path)) === !i.system);
  return isDefault ? undefined : JSON.stringify(all.filter((i) => checked.has(pathKey(i.path))).map((i) => i.path));
}

/** The checked set a data source starts with: its `visibleSchemas`, else the non-system schemas. */
export function initialChecked(ds: DataSource, groups: SchemaGroup[]): Set<string> {
  const v = visibleSchemas(ds);
  if (v) return new Set(v.map(pathKey));
  return new Set(groups.flatMap((g) => g.items).filter((i) => !i.system).map((i) => pathKey(i.path)));
}

async function save(ds: DataSource, value: string | undefined): Promise<void> {
  await updateDataSource(ds.id, (cfg) => {
    const options = { ...cfg.options };
    if (value === undefined) delete options.visibleSchemas;
    else options.visibleSchemas = value;
    return { ...cfg, options };
  });
}

function Selector(props: { ds: DataSource; groups: SchemaGroup[]; anchor: DOMRect; close: (apply: boolean, checked: ReadonlySet<string>) => void }) {
  const [checked, setChecked] = createSignal<ReadonlySet<string>>(initialChecked(props.ds, props.groups));
  let root!: HTMLDivElement;
  const all = () => props.groups.flatMap((g) => g.items);
  const set = (items: SchemaItem[], on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      for (const i of items) on ? n.add(pathKey(i.path)) : n.delete(pathKey(i.path));
      return n;
    });
  const state = (items: SchemaItem[]) => {
    const n = items.filter((i) => checked().has(pathKey(i.path))).length;
    return { checked: n > 0 && n === items.length, partial: n > 0 && n < items.length };
  };

  const onDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) props.close(true, checked());
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.close(false, checked());
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      props.close(true, checked());
    }
  };
  onMount(() => {
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    root.querySelector<HTMLElement>("[role=checkbox]")?.focus();
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
  });

  const left = Math.max(4, Math.min(props.anchor.left, window.innerWidth - 324));
  const top = Math.min(props.anchor.bottom + 4, window.innerHeight - 340);
  const labelOf = (i: SchemaItem) => (
    <>
      {i.name}
      <Show when={i.system}>
        <span class="dg-schemasel-note"> system</span>
      </Show>
    </>
  );

  return (
    <div ref={root} class="dg-schemasel" style={{ left: left + "px", top: top + "px" }} role="dialog" aria-label="Schemas">
      <div class="dg-schemasel-list">
        <div class="dg-schemasel-row">
          <Checkbox checked={state(all()).checked} indeterminate={state(all()).partial} onChange={(c) => set(all(), c)} label="All schemas" />
        </div>
        <For each={props.groups}>
          {(g) => (
            <>
              <Show when={g.name}>
                <div class="dg-schemasel-row">
                  <Checkbox
                    checked={state(g.items).checked}
                    indeterminate={state(g.items).partial}
                    onChange={(c) => set(g.items, c)}
                    label={<span class="dg-schemasel-db">{g.name}</span>}
                  />
                </div>
              </Show>
              <For each={g.items}>
                {(i) => (
                  <div class="dg-schemasel-row" classList={{ "dg-schemasel-child": !!g.name }}>
                    <Checkbox checked={checked().has(pathKey(i.path))} onChange={(c) => set([i], c)} label={labelOf(i)} />
                  </div>
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <div class="dg-schemasel-foot">Press Enter or click outside the list to apply</div>
    </div>
  );
}

let openPop: (() => void) | undefined;

/** Opens the popup under `anchor` for the data source `dsId`. */
export async function openSchemaSelector(dsId: string, anchor: HTMLElement): Promise<void> {
  openPop?.();
  const ds = dsOf(dsId);
  if (!ds) return;
  let groups: SchemaGroup[];
  try {
    groups = await loadSchemaGroups(ds);
  } catch (e) {
    notify({ kind: "error", title: "Cannot list the schemas", body: String((e as Error)?.message ?? e) });
    return;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  let dispose: (() => void) | undefined;
  let closed = false;
  const close = (apply: boolean, checked: ReadonlySet<string>) => {
    if (closed) return;
    closed = true;
    openPop = undefined;
    const value = visibleSchemasOption(groups, checked);
    const before = visibleSchemas(ds) ? ds.options.visibleSchemas : undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
    });
    if (apply && value !== before) void save(ds, value).catch((e) => notify({ kind: "error", title: "Cannot save the schemas", body: String((e as Error)?.message ?? e) }));
  };
  openPop = () => close(false, new Set());
  dispose = render(() => <Selector ds={ds} groups={groups} anchor={anchor.getBoundingClientRect()} close={close} />, host);
}
