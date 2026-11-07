/**
 * Schema selector popup (click on the `1` / `2 of 4` badge of a data source or database node): a toolbar (refresh,
 * expand all, collapse all) over the checkbox tree of the schemas with `All schemas  add pattern` and `Default
 * schema (public)`. The choice is a view filter kept in the UI state (the same store as Data Sources > Schemas),
 * so applying it refreshes the tree and does NOT reconnect: sessions and their open transactions stay. Enter or a
 * click outside applies, Escape cancels.
 */
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { DataSource } from "../../api/db";
import { ActionButton, notify } from "../../components/ui";
import { SchemaFilterTree } from "../datasource/SchemaFilterTree";
import { type SchemaFilter, pathKey, serializeFilter } from "../datasource/schemaModel";
import { visibleSchemasRaw } from "../datasource/schemas";
import { dsOf, forgetListings } from "./core";
import { type SchemaGroup, initialFilter, loadSchemaGroups, save } from "./schemaFilter";

function Selector(props: {
  ds: DataSource;
  groups: SchemaGroup[];
  anchor: DOMRect;
  reload: () => Promise<SchemaGroup[]>;
  close: (apply: boolean, filter: SchemaFilter, groups: SchemaGroup[]) => void;
}) {
  const [groups, setGroups] = createSignal(props.groups);
  const [filter, setFilter] = createSignal<SchemaFilter>(initialFilter(props.ds, props.groups));
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  let root!: HTMLDivElement;

  const onDown = (e: MouseEvent) => {
    if (!root.contains(e.target as Node)) props.close(true, filter(), groups());
  };
  const onKey = (e: KeyboardEvent) => {
    // Enter / Escape inside the pattern field belong to the field
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.close(false, filter(), groups());
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      props.close(true, filter(), groups());
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

  const dbKeys = () => groups().filter((g) => g.name).map((g) => pathKey([g.name!]));
  const left = Math.max(4, Math.min(props.anchor.left, window.innerWidth - 344));
  const top = Math.min(props.anchor.bottom + 4, window.innerHeight - 400);

  return (
    <div ref={root} class="dg-schemasel" style={{ left: left + "px", top: top + "px" }} role="dialog" aria-label="Schemas">
      <div class="dg-schemasel-toolbar">
        <ActionButton
          icon="refresh"
          title="Refresh"
          onClick={async () => {
            try {
              setGroups(await props.reload());
            } catch (e) {
              notify({ kind: "error", title: "Cannot list the schemas", body: String((e as Error)?.message ?? e) });
            }
          }}
        />
        <Show when={dbKeys().length}>
          <ActionButton icon="expand-all" title="Expand All" onClick={() => setCollapsed(new Set())} />
          <ActionButton icon="collapse-all" title="Collapse All" onClick={() => setCollapsed(new Set(dbKeys()))} />
        </Show>
      </div>
      <div class="dg-schemasel-list">
        <SchemaFilterTree
          groups={groups()}
          filter={filter()}
          onChange={setFilter}
          collapsed={collapsed()}
          onToggleCollapse={(k) =>
            setCollapsed((c) => {
              const n = new Set(c);
              n.has(k) ? n.delete(k) : n.add(k);
              return n;
            })
          }
        />
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
  const close = (apply: boolean, filter: SchemaFilter, shown: SchemaGroup[]) => {
    if (closed) return;
    closed = true;
    openPop = undefined;
    const value = serializeFilter(filter, shown.flatMap((g) => g.items));
    const before = visibleSchemasRaw(ds) || undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
    });
    if (apply && value !== before) void save(ds, value).catch((e) => notify({ kind: "error", title: "Cannot save the schemas", body: String((e as Error)?.message ?? e) }));
  };
  openPop = () => close(false, { paths: [], patterns: [], useDefault: false, objects: "" }, groups);
  dispose = render(
    () => (
      <Selector
        ds={ds}
        groups={groups}
        anchor={anchor.getBoundingClientRect()}
        reload={async () => {
          forgetListings(ds.id);
          groups = await loadSchemaGroups(ds);
          return groups;
        }}
        close={close}
      />
    ),
    host,
  );
}
