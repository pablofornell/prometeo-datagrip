/** New > View / Materialized View / Sequence / Schema (and Modify Schema on PostgreSQL): the same dialog with one node. */
import { Show, createMemo, type JSX } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { SqlEditor } from "../../components/editor";
import { Checkbox, Tree, type TreeItem } from "../../components/ui";
import { createConsole, writeConsole } from "../../api/db";
import { openConsoleTab } from "../explorer/commands";
import { NodeIcon } from "../explorer/NodeIcon";
import { iconOf } from "../explorer/model";
import { askChoice } from "../table/dialogs";
import { runPlan } from "./apply";
import { Field, Text } from "./fields";
import { EditorFrame } from "./Frame";
import { type EditorCtx, errText } from "./load";
import { type ObjectDef, OBJECT_TITLE, alterSchemaPlan, createObjectPlan, validateObject } from "./objects";
import { planText } from "./sqlgen";
import { createSignal } from "solid-js";

export interface ObjectEditorProps {
  ctx: EditorCtx;
  /** The object being created; for Modify Schema its loaded state is `orig`. */
  initial: ObjectDef;
  orig?: ObjectDef;
  onClose: () => void;
  onApplied: () => void;
}

const ICON: Record<ObjectDef["kind"], string | undefined> = {
  view: "data-schema",
  materializedView: iconOf("materializedView"),
  sequence: iconOf("sequence"),
  schema: iconOf("schema"),
};

export function ObjectEditor(props: ObjectEditorProps): JSX.Element {
  const { ctx } = props;
  const d = ctx.driver;
  const [cur, setCur] = createStore<ObjectDef>({ ...props.initial });
  const initialJson = JSON.stringify(props.initial);
  const dirty = () => JSON.stringify(unwrap(cur)) !== initialJson;
  const [busy, setBusy] = createSignal(false);
  const [applyError, setApplyError] = createSignal("");

  const plan = createMemo(() => (props.orig ? alterSchemaPlan(d, props.orig, cur) : createObjectPlan(d, cur)));
  const problem = createMemo(() => validateObject(cur)[0]);
  const where = () => (cur.kind === "schema" ? `[${ctx.dsName}]` : `${ctx.schema} [${ctx.dsName}]`);

  const roots = createMemo<TreeItem[]>(() => [{ id: "root", label: cur.name || "<unnamed>", hint: where(), data: ICON[cur.kind], labelClass: props.orig ? undefined : "dgse-new" }]);

  async function ok(): Promise<void> {
    if (busy()) return;
    if (props.orig && !dirty()) return props.onClose();
    setBusy(true);
    setApplyError("");
    try {
      await runPlan(ctx.dsId, plan());
    } catch (e) {
      setApplyError(errText(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    props.onApplied();
    props.onClose();
  }

  async function cancel(): Promise<void> {
    if (dirty()) {
      const a = await askChoice({
        title: "Unsaved Changes",
        message: "You're about to lose your changes.",
        choices: [
          { label: "OK", value: "ok", primary: true },
          { label: "Cancel", value: "cancel" },
        ],
        cancel: "cancel",
      });
      if (a !== "ok") return;
    }
    props.onClose();
  }

  async function toConsole(): Promise<void> {
    try {
      const name = await createConsole(ctx.dsId);
      await writeConsole(ctx.dsId, name, planText(plan()) + "\n");
      props.onClose();
      openConsoleTab(ctx.dsId, name);
    } catch (e) {
      setApplyError(errText(e));
    }
  }

  const isView = () => cur.kind === "view" || cur.kind === "materializedView";
  const hasComment = () => d === "postgres";

  return (
    <EditorFrame
      toolbar={<span class="dgse-title">{OBJECT_TITLE[cur.kind](d)}</span>}
      tree={
        <Tree
          class="dgse-tree"
          roots={roots()}
          selectedId="root"
          speedSearchField={false}
          renderLabel={(item) => (
            <>
              <NodeIcon name={item.data as string | undefined} class="dg-tree-icon" />
              <span class={"dg-tree-label" + (item.labelClass ? " " + item.labelClass : "")}>{item.label}</span>
              <span class="dg-tree-hint">{item.hint}</span>
            </>
          )}
        />
      }
      sheet={
        <div class="dgse-sheet">
          <div class="dgse-chip">
            <NodeIcon name={ICON[cur.kind]} />
            <span>{cur.name || " "}</span>
          </div>
          <Field label="Name">
            <Text name value={cur.name} onInput={(v) => setCur("name", v)} error={!cur.name.trim()} />
          </Field>
          <Show when={hasComment()}>
            <Field label="Comment">
              <Text value={cur.comment} onInput={(v) => setCur("comment", v)} />
            </Field>
          </Show>
          <Show when={isView()}>
            <Field label="Query" top>
              <div class="dgse-query">
                <SqlEditor value={cur.query} onChange={(v) => setCur("query", v)} dialect={d} gutter={false} stripe={false} statementFrame={false} placeholder="select … from …" />
              </div>
            </Field>
          </Show>
          <Show when={cur.kind === "sequence"}>
            <Field label="Start">
              <Text mono value={cur.start} onInput={(v) => setCur("start", v)} placeholder="1" />
            </Field>
            <Field label="Increment">
              <Text mono value={cur.increment} onInput={(v) => setCur("increment", v)} placeholder="1" />
            </Field>
            <Field label="Min Value">
              <Text mono value={cur.minValue} onInput={(v) => setCur("minValue", v)} />
            </Field>
            <Field label="Max Value">
              <Text mono value={cur.maxValue} onInput={(v) => setCur("maxValue", v)} />
            </Field>
            <Field label="">
              <Checkbox checked={cur.cycle} onChange={(v) => setCur("cycle", v)} label="Cycle" />
            </Field>
          </Show>
        </div>
      }
      preview={planText(plan())}
      dialect={d}
      problem={problem()}
      busy={busy()}
      applyError={applyError()}
      canOk={!problem()}
      onOk={() => void ok()}
      onCancel={() => void cancel()}
      onConsole={() => void toConsole()}
    />
  );
}
