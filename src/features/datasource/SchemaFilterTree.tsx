/**
 * The checkbox tree of the schema filter: `All schemas  add pattern`, `Default schema (public)`, then the schemas
 * (PostgreSQL: under their database). Shared by the schema selector popup of the explorer and Data Sources > Schemas.
 * The filter logic is `schemaModel.ts`; this component only draws and edits a `SchemaFilter`.
 */
import { For, Show, createSignal } from "solid-js";
import { Checkbox, Icon, TextField } from "../../components/ui";
import {
  type SchemaFilter,
  type SchemaItem,
  checkState,
  groupState,
  pathKey,
  splitPatterns,
  toggleGroup,
  toggleItem,
} from "./schemaModel";

export interface SchemaTreeGroup {
  /** PostgreSQL database; null for MySQL / SQLite. */
  name: string | null;
  items: SchemaItem[];
}

export function SchemaFilterTree(props: {
  groups: SchemaTreeGroup[];
  filter: SchemaFilter;
  onChange: (f: SchemaFilter) => void;
  /** Keys (`pathKey` of the database) of the collapsed database rows. */
  collapsed?: ReadonlySet<string>;
  onToggleCollapse?: (key: string) => void;
  /** Search text of the Schemas tab: only the schemas that contain it are listed. */
  query?: string;
}) {
  const [editing, setEditing] = createSignal(false);
  const all = () => props.groups.flatMap((g) => g.items);
  const q = () => (props.query ?? "").trim().toLowerCase();
  const matches = (i: SchemaItem) => !q() || i.name.toLowerCase().includes(q());
  const defaultName = () => all().find((i) => i.isDefault)?.name;
  const patternText = () => props.filter.patterns.join(", ");

  const commit = (text: string) => {
    setEditing(false);
    const patterns = splitPatterns(text);
    if (patterns.join("\u0000") !== props.filter.patterns.join("\u0000")) props.onChange({ ...props.filter, patterns });
  };

  /** `add pattern` link of the `All schemas` row; shows the patterns once there are some. */
  const PatternField = () => (
    <Show
      when={editing()}
      fallback={
        <button
          type="button"
          class="dg-sft-pattern"
          classList={{ "dg-sft-has": props.filter.patterns.length > 0 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setEditing(true)}
        >
          {patternText() || "add pattern"}
        </button>
      }
    >
      <TextField
        value={patternText()}
        frameClass="dg-sft-pattern-field"
        placeholder="sales*, !temp*"
        ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
        onKeyDown={(e) => {
          e.stopPropagation(); // not the popup's Enter / Escape
          if (e.key === "Enter") commit(e.currentTarget.value);
          else if (e.key === "Escape") setEditing(false);
        }}
        onBlur={(e) => editing() && commit(e.currentTarget.value)}
      />
    </Show>
  );

  const rows = (items: SchemaItem[], child: boolean) => (
    <>
      <div class="dg-sft-row" classList={{ "dg-sft-child": child }}>
        <Checkbox
          checked={groupState(props.filter, items) === "on"}
          indeterminate={groupState(props.filter, items) === "mixed"}
          onChange={(c) => props.onChange(toggleGroup(props.filter, items, c))}
          label="All schemas"
        />
        <PatternField />
      </div>
      <Show when={defaultName()}>
        <div class="dg-sft-row" classList={{ "dg-sft-child": child }}>
          <Checkbox
            checked={props.filter.useDefault}
            onChange={(c) => props.onChange({ ...props.filter, useDefault: c })}
            label={
              <>
                Default schema <span class="dg-sft-note">({defaultName()})</span>
              </>
            }
          />
        </div>
      </Show>
      <For each={items.filter(matches)}>
        {(i) => (
          <div class="dg-sft-row" classList={{ "dg-sft-child": child }}>
            <Checkbox
              checked={checkState(props.filter, i) === "on"}
              indeterminate={checkState(props.filter, i) === "mixed"}
              onChange={(c) => props.onChange(toggleItem(props.filter, i, c))}
              label={
                <>
                  {i.name}
                  <Show when={i.isDefault}>
                    <span class="dg-sft-note"> (Default schema)</span>
                  </Show>
                  <Show when={i.system}>
                    <span class="dg-sft-note"> system</span>
                  </Show>
                </>
              }
            />
          </div>
        )}
      </For>
    </>
  );

  return (
    <div class="dg-sft">
      <For each={props.groups}>
        {(g) => (
          <Show when={g.name !== null} fallback={rows(g.items, false)}>
            <div class="dg-sft-row dg-sft-db">
              <span class="dg-sft-chevron" onClick={() => props.onToggleCollapse?.(pathKey([g.name!]))}>
                <Icon name={props.collapsed?.has(pathKey([g.name!])) ? "chevron-right" : "chevron-down"} />
              </span>
              <Checkbox
                checked={groupState(props.filter, g.items) === "on"}
                indeterminate={groupState(props.filter, g.items) === "mixed"}
                onChange={(c) => props.onChange(toggleGroup(props.filter, g.items, c))}
                label={
                  <>
                    <span class="dg-sft-dbname">{g.name}</span>
                    <span class="dg-sft-note"> (Default database)</span>
                  </>
                }
              />
            </div>
            <Show when={!props.collapsed?.has(pathKey([g.name!]))}>{rows(g.items, true)}</Show>
          </Show>
        )}
      </For>
    </div>
  );
}
