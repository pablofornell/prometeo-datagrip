/**
 * WHERE | ORDER BY row of the table data editor. Same look as the grid kit's `GridFilterBar`
 * (classes `dgg-fb*`), but the fields are single-line SQL editors with completion of the table's columns.
 */
import { Show, createMemo, type JSX } from "solid-js";
import type { ColumnMeta, Driver, ObjectRef } from "../../api/types";
import { SqlEditor } from "../../components/editor";
import type { SchemaSnapshot } from "../../components/editor";

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

  const half = (kind: "where" | "order", label: string, value: () => string, set: (v: string) => void): JSX.Element => (
    <div class="dgg-fb-half dgt-fb-half" data-fb={kind}>
      <i class={"dgg-i " + (kind === "where" ? "i-filter" : "i-sortBy")} />
      <span class="dgg-fb-label" classList={{ filled: value().length > 0 }}>
        {label}
      </span>
      <SqlEditor
        class="dgt-fb-editor"
        singleLine
        value={value()}
        onChange={set}
        onSubmit={props.onApply}
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
            props.onApply();
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
