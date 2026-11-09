/**
 * "Compare Schemas" picker: the schema on the left is fixed (A); the right one (B) is chosen from the data sources and
 * their schemas. The schemas of the chosen data source are listed once it is connected (the default database for
 * PostgreSQL, the schemas the server lists otherwise), system schemas left out.
 */
import { Show, createSignal, onMount, type JSX } from "solid-js";
import { ComboBox, Dialog, type ComboOption } from "../../components/ui";
import { ensureConnected, explorerDataSources } from "../explorer";
import { type SchemaItem, loadSchemaGroups } from "../explorer/schemaFilter";
import { errText } from "../table/ds";
import type { SchemaRef } from "./model";

export interface CompareDialogProps {
  /** The schema compared (A), shown as `schema [data source]`. */
  left: SchemaRef;
  onClose: () => void;
  onPick: (right: SchemaRef) => void;
}

export function CompareDialog(props: CompareDialogProps): JSX.Element {
  const sources = () => explorerDataSources();
  const [dsId, setDsId] = createSignal(props.left.dsId);
  const [schemas, setSchemas] = createSignal<SchemaItem[]>([]);
  const [schema, setSchema] = createSignal<string | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  let seq = 0;

  /** Connects the data source and lists its schemas; a late answer for another data source is dropped. */
  const load = async (id: string) => {
    const mine = ++seq;
    setLoading(true);
    setError("");
    setSchemas([]);
    setSchema(undefined);
    try {
      const ds = sources().find((d) => d.id === id);
      if (!ds) return;
      await ensureConnected(id);
      const groups = await loadSchemaGroups(ds);
      const items = groups
        .filter((g) => g.name === null || g.name === ds.database)
        .flatMap((g) => g.items)
        .filter((i) => !i.system);
      if (mine === seq) setSchemas(items);
    } catch (e) {
      if (mine === seq) setError(errText(e));
    } finally {
      if (mine === seq) setLoading(false);
    }
  };

  onMount(() => void load(dsId()));

  const dsOptions = (): ComboOption<string>[] => sources().map((d) => ({ value: d.id, label: d.name, icon: "dg/dbms" }));
  const schemaOptions = (): ComboOption<string>[] =>
    schemas().map((s) => ({ value: s.name, label: s.isDefault ? `${s.name} (default)` : s.name }));
  const sameAsLeft = () => dsId() === props.left.dsId && schema() === props.left.schema;
  const leftName = () => `${props.left.schema} [${sources().find((d) => d.id === props.left.dsId)?.name ?? props.left.dsId}]`;
  const problem = () => error() || (schema() && sameAsLeft() ? "Choose another schema: the left one is compared with itself." : "");

  return (
    <Dialog
      title="Compare Schemas"
      width={520}
      onClose={props.onClose}
      footerLeft={
        <Show when={problem()}>
          <span class="dgd-problem" role="alert">
            {problem()}
          </span>
        </Show>
      }
      buttons={[
        {
          label: "Compare",
          primary: true,
          disabled: !schema() || loading() || sameAsLeft(),
          run: () => {
            const s = schema();
            if (s) props.onPick({ dsId: dsId(), schema: s });
          },
        },
        { label: "Cancel", run: props.onClose },
      ]}
    >
      <div class="sd-form">
        <label>Schema A:</label>
        <div class="sd-fixed" title="The schema compared">{leftName()}</div>
        <label>Data source B:</label>
        <ComboBox
          options={dsOptions()}
          value={dsId()}
          onChange={(id) => {
            setDsId(id);
            void load(id);
          }}
        />
        <label>Schema B:</label>
        <div class="sd-schema-pick">
          <ComboBox options={schemaOptions()} value={schema()} placeholder={loading() ? "Loading..." : "Choose a schema"} disabled={loading() || schemas().length === 0} onChange={setSchema} />
        </div>
        <Show when={!loading() && !error() && schemas().length === 0 && dsId()}>
          <span class="sd-hint">No schema of this data source is listed.</span>
        </Show>
      </div>
    </Dialog>
  );
}
