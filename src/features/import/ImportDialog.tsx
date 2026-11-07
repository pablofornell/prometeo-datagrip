/**
 * Import Data dialog (DataGrip 107 / 107b): left tree `from: file` > `to: table`, a settings pane for the selected
 * node (file format / target and column mapping), and Data Preview / DDL Preview tabs below.
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, on, untrack, type JSX } from "solid-js";
import {
  type Cell,
  type Driver,
  type ImportFormat,
  type ImportPreview,
  type ImportRequest,
  type ImportSource,
  chooseExportPath,
  chooseImportFile,
  defaultImportFormat,
  importPreview,
} from "../../api/db";
import { Checkbox, ComboBox, Dialog, Icon, Tabs, TextField, openMenu } from "../../components/ui";
import { DataGrid, type GridColumn, highlightSql } from "../../components/grid";
import { askChoice } from "../table/dialogs";
import { errText } from "../table/ds";
import {
  ENCODINGS,
  FORMAT_OPTIONS,
  type FormatKind,
  type MapRow,
  TYPE_CHOICES,
  autoMatch,
  createTableSql,
  existingRows,
  formatKindOf,
  formatLabel,
  insertSql,
  mappingProblem,
  newRows,
  requestColumns,
  tableNameForFile,
} from "./model";
import "./import.css";

export interface TableInfo {
  name: string;
  columns: { name: string; type: string }[];
}

export interface ImportDialogProps {
  dsId: string;
  dsName: string;
  driver: Driver;
  source: ImportSource;
  /** Schemas of the data source (names). */
  schemas: string[];
  /** Schema to start with. */
  schema: string | null;
  /** Existing table to start with (the dialog was opened on a table). */
  table?: string;
  loadTables: (schema: string | null) => Promise<TableInfo[]>;
  onClose: () => void;
  onSubmit: (req: ImportRequest, label: string) => void;
}

type Node = "source" | "target";

/** Keywords of the previews that the grid's SQL highlighter does not know. */
const DDL_KEYWORDS = new Set(["CREATE", "TABLE", "PRIMARY", "KEY", "UNIQUE", "IF", "EXISTS"]);

const GENERIC = (t: string) => t.toUpperCase().replace("DOUBLE", "DOUBLE PRECISION");

/** A label above / left of a field, DataGrip's form layout. */
function Field(props: { label: string; children: JSX.Element; wide?: boolean }): JSX.Element {
  return (
    <div class="dgi-field">
      <label class="dgi-label">{props.label}</label>
      <div class="dgi-control">{props.children}</div>
    </div>
  );
}

/** Preview cell of a column of an inferred type (integers and booleans as typed values). */
function previewCell(v: string | null, type: string): Cell {
  if (v === null) return null;
  if (type === "boolean") return /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : v;
  // integers become numbers; decimals stay as written (24.50)
  if (type === "integer") {
    const n = Number(v);
    return v.trim() !== "" && Number.isSafeInteger(n) ? n : v;
  }
  return v;
}

export function ImportDialog(props: ImportDialogProps): JSX.Element {
  const [source, setSource] = createSignal(props.source);
  const [format, setFormat] = createSignal<ImportFormat>(defaultImportFormat());
  const [node, setNode] = createSignal<Node>("target");
  const [tab, setTab] = createSignal<"data" | "ddl">("data");
  const [dirty, setDirty] = createSignal(false);

  const [schema, setSchema] = createSignal<string | null>(props.schema ?? props.schemas[0] ?? null);
  const [tableName, setTableName] = createSignal(props.table ?? tableNameForFile(props.source.name));
  const [rows, setRows] = createSignal<MapRow[]>([]);
  const [writeErrors, setWriteErrors] = createSignal(true);
  const [errorFile, setErrorFile] = createSignal(props.source.defaultErrorFile);
  const [asNull, setAsNull] = createSignal(false);
  const [abortOnError, setAbortOnError] = createSignal(false);

  // ---- the file: re-read whenever the format changes
  const [preview] = createResource(
    () => ({ path: source().path, format: format() }),
    (k): Promise<ImportPreview | { error: string }> => importPreview(k.path, k.format, 10).catch((e) => ({ error: errText(e) })),
  );
  const pv = (): ImportPreview | undefined => {
    const p = preview.latest;
    return p && !("error" in p) ? p : undefined;
  };
  const previewError = (): string | undefined => {
    const p = preview.latest;
    return p && "error" in p ? p.error : undefined;
  };
  const fileColumns = () => pv()?.columns.map((c) => c.name) ?? [];

  // ---- the target
  const [tables] = createResource(schema, (s) => props.loadTables(s).catch(() => [] as TableInfo[]));
  const existing = createMemo(() => {
    const n = tableName().trim();
    const list = tables.latest ?? [];
    return list.find((t) => t.name === n) ?? (props.driver === "postgres" ? undefined : list.find((t) => t.name.toLowerCase() === n.toLowerCase()));
  });
  const isNew = () => !existing();

  // The mapping is rebuilt when the table it maps to, or the columns of the file, change.
  const mappingKey = () => `${existing()?.name ?? ""}\u0000${JSON.stringify(pv()?.columns ?? [])}\u0000${tables.loading}`;
  createEffect(
    on(mappingKey, () => {
      const p = pv();
      if (!p || tables.loading) return;
      const ex = existing();
      setRows(ex ? existingRows(ex.columns) : newRows(props.driver, p.columns));
    }),
  );

  const touch =
    <T,>(set: (v: T) => void) =>
    (v: T): void => {
      setDirty(true);
      set(v);
    };
  const patchFormat = (p: Partial<ImportFormat>) => touch(setFormat)({ ...format(), ...p });
  const patchRow = (i: number, p: Partial<MapRow>) => touch(setRows)(rows().map((r, j) => (j === i ? { ...r, ...p } : r)));

  const problem = createMemo(() => {
    if (previewError()) return previewError()!;
    if (!pv()) return "Reading the file…";
    return mappingProblem(rows(), fileColumns(), isNew(), tableName());
  });

  const request = (): ImportRequest => ({
    path: source().path,
    format: format(),
    schema: schema(),
    table: tableName().trim(),
    createTable: isNew(),
    columns: requestColumns(rows(), fileColumns(), isNew()),
    options: { insertInconvertibleAsNull: asNull(), abortOnError: abortOnError(), errorFile: writeErrors() ? errorFile() : null },
  });
  const submit = () => {
    if (problem()) return;
    props.onSubmit(request(), tableName().trim());
  };

  const close = async () => {
    if (dirty()) {
      const answer = await askChoice({
        title: "Warning",
        message: "You're about to lose your changes. Close the dialog anyway?",
        choices: [
          { label: "OK", value: "ok", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (answer !== "ok") return;
    }
    props.onClose();
  };

  const pickFile = async () => {
    try {
      const s = await chooseImportFile();
      if (!s) return;
      setSource(s);
      setErrorFile(s.defaultErrorFile);
      setDirty(true);
    } catch (e) {
      console.error(e);
    }
  };
  const pickErrorFile = async () => {
    try {
      const p = await chooseExportPath(`${tableNameForFile(source().name)}_errors.txt`);
      if (p) touch(setErrorFile)(p);
    } catch (e) {
      console.error(e);
    }
  };

  // ---- previews
  const gridColumns = (): GridColumn[] => pv()?.columns.map((c) => ({ name: c.name, typeName: c.inferredType, readOnly: true })) ?? [];
  const gridRows = (): Cell[][] => {
    const p = pv();
    return p ? p.rows.map((r) => r.map((v, i) => previewCell(v, p.columns[i]?.inferredType ?? "text"))) : [];
  };
  const ddl = (): string => {
    const cols = requestColumns(rows(), fileColumns(), isNew());
    if (!cols.length) return "";
    if (isNew()) return createTableSql(props.driver, schema(), tableName().trim(), cols) + ";";
    const mapped = cols.filter((c) => c.source !== null).map((c) => c.name);
    return `-- ${tableName().trim()} exists: its columns are not changed\n${insertSql(props.driver, schema(), tableName().trim(), mapped)};`;
  };

  // ---- pieces
  const typeMenu = (i: number, anchor: HTMLElement) =>
    openMenu(
      TYPE_CHOICES[props.driver].map((t) => ({ label: t, run: () => patchRow(i, { type: t }) })),
      { anchor, compact: true, minWidth: 160 },
    );
  const tableMenu = (anchor: HTMLElement) =>
    openMenu(
      (tables.latest ?? []).map((t) => ({ label: t.name, icon: "dg/table", checked: t.name === existing()?.name, run: () => touch(setTableName)(t.name) })),
      { anchor, compact: true, minWidth: 220 },
    );
  const fromOptions = (i: number) => {
    const auto = untrack(() => autoMatch(rows().map((r) => r.name), fileColumns()))[i];
    const isNewTable = isNew();
    const autoLabel = isNewTable ? fileColumns()[i] : auto === null ? undefined : fileColumns()[auto];
    return [
      { value: "auto", label: autoLabel ? `<Auto> (${autoLabel})` : "<Auto>" },
      ...fileColumns().map((n, k) => ({ value: String(k), label: n })),
      { value: "skip", label: "<Skip>" },
    ];
  };

  const sourcePane = () => (
    <div class="dgi-pane">
      <div class="dgi-chip">
        <Icon name="csv-file" />
        <span class="dgi-chip-k">from:</span> {source().name}
      </div>
      <Field label="Path">
        <TextField
          value={source().path}
          readOnly
          suffix={
            <span class="dgi-affix-btn" title="Choose another file" onClick={() => void pickFile()}>
              <Icon name="folder" />
            </span>
          }
        />
      </Field>
      <div class="dgi-row">
        <Field label="Charset">
          <ComboBox options={ENCODINGS.map((e) => ({ value: e, label: e }))} value={format().encoding} onChange={(v) => patchFormat({ encoding: v })} width={130} />
        </Field>
        <Field label="Format">
          <ComboBox
            options={FORMAT_OPTIONS}
            value={formatKindOf(format().delimiter)}
            onChange={(k: FormatKind) =>
              patchFormat({ delimiter: k !== "custom" ? FORMAT_OPTIONS.find((f) => f.value === k)!.delimiter : formatKindOf(format().delimiter) === "custom" ? format().delimiter : "~" })
            }
            width={170}
          />
        </Field>
        <Show when={formatKindOf(format().delimiter) === "custom"}>
          <Field label="Delimiter">
            <TextField value={format().delimiter} onInput={(v) => patchFormat({ delimiter: v })} error={!format().delimiter} style={{ width: "56px" }} />
          </Field>
        </Show>
      </div>
      <div class="dgi-row">
        <Field label="Quote">
          <ComboBox
            options={[
              { value: '"', label: '" (double quote)' },
              { value: "'", label: "' (single quote)" },
              { value: "", label: "none" },
            ]}
            value={format().quote}
            onChange={(v) => patchFormat({ quote: v })}
            width={170}
          />
        </Field>
        <Field label="NULL text">
          <TextField value={format().nullText} onInput={(v) => patchFormat({ nullText: v })} placeholder="(empty)" style={{ width: "110px" }} />
        </Field>
      </div>
      <div class="dgi-checks dgi-checks-row">
        <Checkbox checked={format().header} onChange={(v) => patchFormat({ header: v })} label="First row is header" />
        <Checkbox checked={format().firstColumnHeader} onChange={(v) => patchFormat({ firstColumnHeader: v })} label="First column is header" />
        <Checkbox checked={format().trim} onChange={(v) => patchFormat({ trim: v })} label="Trim whitespaces" />
      </div>
      <table class="dgi-table dgi-cols">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          <For each={pv()?.columns ?? []}>
            {(c) => (
              <tr>
                <td>{c.name}</td>
                <td class="dgi-italic">{GENERIC(c.inferredType)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );

  const targetPane = () => (
    <div class="dgi-pane">
      <div class="dgi-chip">
        <Icon name="dg/table" />
        <span class="dgi-chip-k">to:</span> {tableName() || "…"}
      </div>
      <Field label="Schema">
        <ComboBox
          options={props.schemas.map((s) => ({ value: s, label: s, icon: "dg/schema" }))}
          value={schema() ?? undefined}
          onChange={touch(setSchema)}
          width={320}
        />
      </Field>
      <Field label="Table">
        <TextField
          value={tableName()}
          onInput={touch(setTableName)}
          error={!tableName().trim()}
          suffix={
            <>
              <Show when={isNew() && tableName().trim()}>
                <span class="dgi-badge">New: auto</span>
              </Show>
              <span
                class="dgi-affix-btn"
                title="Existing tables"
                onClick={(e) => tableMenu(e.currentTarget as HTMLElement)}
              >
                <Icon name="chevron-down" />
              </span>
            </>
          }
        />
      </Field>
      <div class="dgi-section">Mapping</div>
      <div class="dgi-mapwrap">
        <table class="dgi-table dgi-map">
          <thead>
            <tr>
              <th>to: Column</th>
              <th>to: Type</th>
              <th>from: Column</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r, i) => (
                <tr>
                  <td>
                    <Show when={isNew()} fallback={r.name}>
                      <TextField value={r.name} onInput={(v) => patchRow(i(), { name: v })} error={!r.name.trim()} />
                    </Show>
                  </td>
                  <td>
                    <Show when={isNew()} fallback={<span class="dgi-type">{r.type}</span>}>
                      <TextField
                        value={r.type}
                        onInput={(v) => patchRow(i(), { type: v })}
                        error={!r.type.trim()}
                        suffix={
                          <span class="dgi-affix-btn" onClick={(e) => typeMenu(i(), e.currentTarget as HTMLElement)}>
                            <Icon name="chevron-down" />
                          </span>
                        }
                      />
                    </Show>
                  </td>
                  <td>
                    <ComboBox
                      options={fromOptions(i())}
                      value={r.from === "auto" ? "auto" : r.from === "skip" ? "skip" : String(r.from)}
                      onChange={(v) => patchRow(i(), { from: v === "auto" || v === "skip" ? v : Number(v) })}
                    />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="dgi-checks">
        <div class="dgi-errfile">
          <Checkbox checked={writeErrors()} onChange={touch(setWriteErrors)} label="Write errors to file" />
          <TextField
            value={errorFile()}
            readOnly
            disabled={!writeErrors()}
            suffix={
              <span class="dgi-affix-btn" title="Choose the file" onClick={() => writeErrors() && void pickErrorFile()}>
                <Icon name="folder" />
              </span>
            }
          />
        </div>
        <Checkbox checked={asNull()} onChange={touch(setAsNull)} label="Insert inconvertible values as null" />
        <Checkbox checked={abortOnError()} onChange={touch(setAbortOnError)} label="Stop at the first error and roll everything back" />
      </div>
    </div>
  );

  return (
    <Dialog
      title="Import Data"
      width={900}
      height={700}
      flush
      onClose={() => void close()}
      footerLeft={
        <Show when={problem()}>
          <span class="dgi-problem" classList={{ "dgi-problem-error": !!previewError() || (!!pv() && !!problem()) }}>
            {problem()}
          </span>
        </Show>
      }
      buttons={[
        { label: "OK", primary: true, disabled: !!problem(), run: submit },
        { label: "Cancel", run: () => void close() },
      ]}
    >
      <div class="dgi-root">
        <div class="dgi-top">
          <div class="dgi-tree" role="tree">
            <div class="dgi-node" classList={{ "dgi-selected": node() === "source" }} role="treeitem" tabindex={0} onClick={() => setNode("source")}>
              <Icon name="csv-file" />
              <span class="dgi-chip-k">from:</span>
              <span class="dgi-node-name dgi-source">{source().name}</span>
            </div>
            <div class="dgi-node dgi-child" classList={{ "dgi-selected": node() === "target" }} role="treeitem" tabindex={0} onClick={() => setNode("target")}>
              <Icon name="dg/table" />
              <span class="dgi-chip-k">to:</span>
              <span class="dgi-node-name">{tableName() || "…"}</span>
              <span class="dgi-node-loc">
                {schema() ? `${schema()} ` : ""}[{props.dsName}]
              </span>
            </div>
          </div>
          <div class="dgi-settings">{node() === "source" ? sourcePane() : targetPane()}</div>
        </div>
        <div class="dgi-bottom">
          <Tabs
            variant="dialog"
            items={[
              { id: "data", title: "Data Preview" },
              { id: "ddl", title: "DDL Preview" },
            ]}
            active={tab()}
            onSelect={(id) => setTab(id as "data" | "ddl")}
          />
          <Show when={tab() === "data"}>
            <div class="dgi-note">
              file: {source().name}&nbsp;&nbsp;format: {formatLabel(format())}
              <Show when={pv()?.truncated || (pv()?.rows.length ?? 0) >= 10}> &nbsp;&nbsp;first 10 rows</Show>
            </div>
            <div class="dgi-preview">
              <Show when={!previewError()} fallback={<div class="dgi-error">{previewError()}</div>}>
                <Show when={pv()}>
                  <DataGrid columns={gridColumns()} rowCount={gridRows().length} getRow={(i) => gridRows()[i]} version={gridRows().length} />
                </Show>
              </Show>
            </div>
          </Show>
          <Show when={tab() === "ddl"}>
            <pre class="dgi-ddl">
              <For each={highlightSql(ddl()).map((x) => (!x.cls && DDL_KEYWORDS.has(x.text.toUpperCase()) ? { ...x, cls: "kw" } : x))}>{(s) => (s.cls ? <span class={"sq-" + s.cls}>{s.text}</span> : s.text)}</For>
            </pre>
          </Show>
        </div>
      </div>
    </Dialog>
  );
}
