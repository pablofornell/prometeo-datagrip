/**
 * WHERE | ORDER BY row of the table data editor. Same look as the grid kit's `GridFilterBar`
 * (classes `dgg-fb*`), but the fields are single-line SQL editors with completion of the table's columns.
 */
import { Show, createMemo, type JSX } from "solid-js";
import type { ColumnMeta, Driver, ObjectRef } from "../../api/types";
import { SqlEditor } from "../../components/editor";
import type { SchemaSnapshot } from "../../components/editor";
import { type MenuItem, openMenu } from "../../components/ui";
import { type FilterKind, filterHistory, rememberFilter } from "./filterHistory";

export interface FilterBarProps {
  driver: Driver;
  objectRef: ObjectRef;
  columns: ColumnMeta[];
  sourceLabel?: string;
  where: string;
  orderBy: string;
  onWhereChange: (v: string) => void;
  onOrderByChange: (v: string) => void;
  /** Enter in either field, or a clear button. */
  onApply: () => void;
}

export function FilterBar(props: FilterBarProps): JSX.Element {
  const schemaName = () => props.objectRef.schema ?? (props.driver === "sqlite" ? "main" : "public");
  /** Snapshot with just this table: unqualified column names resolve against it (`scopeTable`). */
  const schema = createMemo<SchemaSnapshot>(() => ({
    schemas: [
      {
        name: schemaName(),
        tables: [
          {
            name: props.objectRef.name,
            kind: props.objectRef.kind === "view" ? "view" : props.objectRef.kind === "materializedView" ? "matview" : "table",
            columns: props.columns.map((c) => ({ name: c.name, type: c.typeName, key: c.isPk ? ("pk" as const) : undefined })),
          },
        ],
      },
    ],
  }));

  const tableKey = () => `${props.sourceLabel ?? ""}\u0000${props.objectRef.schema ?? ""}\u0000${props.objectRef.name}`;

  /** Applies and remembers what is in the fields. */
  const apply = () => {
    rememberFilter(tableKey(), "where", props.where);
    rememberFilter(tableKey(), "order", props.orderBy);
    props.onApply();
  };

  /** History popup of the funnel / sort icon: the last applied texts of this table, newest first. */
  const openHistory = (kind: FilterKind, anchor: HTMLElement, set: (v: string) => void) => {
    const list = filterHistory(tableKey(), kind);
    const items: MenuItem[] = list.length
      ? list.map((t) => ({
          label: t.length > 80 ? t.slice(0, 79) + "…" : t,
          run: () => {
            set(t);
            apply();
          },
        }))
      : [{ type: "hint", label: kind === "where" ? "No filters applied yet" : "No sort orders applied yet" }];
    openMenu(items, { anchor, compact: true, minWidth: 260, selected: list.length ? 0 : undefined });
  };

  const half = (kind: FilterKind, label: string, value: () => string, set: (v: string) => void): JSX.Element => (
    <div
      class="dgg-fb-half dgt-fb-half"
      data-fb={kind}
      ref={(el) =>
        // Alt+Down in an empty field opens the history (captured: the editor would use the key for the caret)
        el.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "ArrowDown" && e.altKey && !e.ctrlKey && !e.shiftKey && value() === "") {
              e.preventDefault();
              e.stopPropagation();
              openHistory(kind, el.querySelector<HTMLElement>("i.dgg-i") ?? el, set);
            }
          },
          true,
        )
      }
    >
      <i
        class={"dgg-i dgt-fb-icon " + (kind === "where" ? "i-filter" : "i-sortBy")}
        title={kind === "where" ? "Filter history (Alt+Down)" : "Sort history (Alt+Down)"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => openHistory(kind, e.currentTarget, set)}
      />
      <span class="dgg-fb-label" classList={{ filled: value().length > 0 }}>
        {label}
      </span>
      <SqlEditor
        class="dgt-fb-editor"
        singleLine
        value={value()}
        onChange={set}
        onSubmit={apply}
        dialect={props.driver}
        schema={schema()}
        defaultSchema={schemaName()}
        sourceLabel={props.sourceLabel}
        scopeTable={{ schema: schemaName(), name: props.objectRef.name }}
      />
      <Show when={value().length > 0}>
        <button
          class="dgg-fb-clear"
          title="Clear"
          tabIndex={-1}
          onClick={() => {
            set("");
            apply();
          }}
        >
          {"×"}
        </button>
      </Show>
    </div>
  );

  return (
    <div class="dgg-fb">
      {half("where", "WHERE", () => props.where, props.onWhereChange)}
      {half("order", "ORDER BY", () => props.orderBy, props.onOrderByChange)}
    </div>
  );
}
