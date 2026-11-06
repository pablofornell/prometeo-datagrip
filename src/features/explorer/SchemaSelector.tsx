/**
 * Schema selector popup (click on the `1` / `2 of 4` badge of a data source or database node): a checklist of the
 * schemas. The choice is a view filter kept in the UI state (the same store as Data Sources > Schemas), so applying it
 * refreshes the tree and does NOT reconnect: sessions and their open transactions stay. Enter or a click outside
 * applies, Escape cancels.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { DataSource } from "../../api/db";
import { Checkbox, notify } from "../../components/ui";
import { pathKey, visibleSchemas, visibleSchemasRaw } from "../datasource/schemas";
import { dsOf } from "./core";
import { type SchemaGroup, type SchemaItem, initialChecked, loadSchemaGroups, save, visibleSchemasOption } from "./schemaFilter";

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
    const before = visibleSchemas(ds) ? visibleSchemasRaw(ds) : undefined;
    queueMicrotask(() => {
      dispose?.();
      host.remove();
    });
    if (apply && value !== before) void save(ds, value).catch((e) => notify({ kind: "error", title: "Cannot save the schemas", body: String((e as Error)?.message ?? e) }));
  };
  openPop = () => close(false, new Set());
  dispose = render(() => <Selector ds={ds} groups={groups} anchor={anchor.getBoundingClientRect()} close={close} />, host);
}
