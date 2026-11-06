/** The Settings pages (operative ones only). Every page edits the dialog's draft, never the live settings. */
import { For, Show, createSignal } from "solid-js";
import { Checkbox, ComboBox, TextField } from "../../components/ui";
import { SqlEditor } from "../../components/editor";
import { DEFAULT_SETTINGS } from "../../state/settings";
import type { ThemePref } from "../../state/theme";
import type { PageNode } from "./model";
import { Hint, L, NumberField, Row, Section, type Draft } from "./widgets";

export function AppearancePage(props: { draft: Draft }) {
  const d = () => props.draft;
  return (
    <div class="st-page">
      <Row field class="st-row-first">
        <span class="st-label">
          <L q={d().query()}>Theme:</L>
        </span>
        <ComboBox<ThemePref>
          width={193}
          value={d().theme()}
          onChange={(t) => d().setTheme(t)}
          options={[
            { value: "dark", label: "Islands Dark" },
            { value: "light", label: "Islands Light" },
            { value: "system", label: "Sync with OS" },
          ]}
        />
      </Row>
    </div>
  );
}

const PREVIEW_SQL = `-- Preview: font size and line height
SELECT c.id, c.name, count(o.id) AS orders
FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.created_at >= '2026-01-01'
  AND o.total > 100.50
GROUP BY c.id, c.name
ORDER BY orders DESC
LIMIT 100;

abcdefghijklmnopqrstuvwxyz
ABCDEFGHIJKLMNOPQRSTUVWXYZ
0123456789 (){}[] <> != >= ->
`;

export function EditorFontPage(props: { draft: Draft }) {
  const d = () => props.draft;
  const q = () => d().query();
  return (
    <div class="st-page st-page-split">
      <div class="st-split-left">
        <Row field class="st-row-first">
          <span class="st-label st-label-narrow">
            <L q={q()}>Font:</L>
          </span>
          <span class="st-static-combo">JetBrains Mono</span>
        </Row>
        <Row field>
          <span class="st-label st-label-narrow">
            <L q={q()}>Size:</L>
          </span>
          <NumberField narrow value={d().values.editorFontSize} min={8} max={40} decimals={1} step={1} onChange={(n) => d().set("editorFontSize", n)} />
          <span class="st-label st-label-inline">
            <L q={q()}>Line height:</L>
          </span>
          <NumberField narrow value={d().values.editorLineHeight} min={1} max={3} decimals={1} step={0.1} onChange={(n) => d().set("editorLineHeight", n)} />
        </Row>
        <Hint>
          Default: {DEFAULT_SETTINGS.editorFontSize.toFixed(1)} and {DEFAULT_SETTINGS.editorLineHeight.toFixed(1)}. The change applies to every open editor.
        </Hint>
      </div>
      <div class="st-split-right">
        <div class="st-preview">
          <SqlEditor
            value={PREVIEW_SQL}
            dialect="postgres"
            readOnly
            gutter={false}
            stripe={false}
            statementFrame={false}
            fontSize={d().values.editorFontSize}
            lineHeight={d().values.editorLineHeight}
          />
        </div>
        <div class="st-preview-hint">Preview</div>
      </div>
    </div>
  );
}

export function EditorAppearancePage(props: { draft: Draft }) {
  const d = () => props.draft;
  return (
    <div class="st-page">
      <Section title="Code Structure" q={d().query()}>
        <Row>
          <Checkbox
            checked={d().values.editorLineNumbers}
            onChange={(c) => d().set("editorLineNumbers", c)}
            label={<L q={d().query()}>Show line numbers</L>}
          />
        </Row>
      </Section>
    </div>
  );
}

export function QueryExecutionPage(props: { draft: Draft }) {
  const d = () => props.draft;
  return (
    <div class="st-page">
      <Section title="Transactions" q={d().query()}>
        <Row field>
          <span class="st-label st-label-wide">
            <L q={d().query()}>Default transaction mode:</L>
          </span>
          <ComboBox<"auto" | "manual">
            width={130}
            value={d().values.defaultTxMode}
            onChange={(m) => d().set("defaultTxMode", m)}
            options={[
              { value: "auto", label: "Auto" },
              { value: "manual", label: "Manual" },
            ]}
          />
        </Row>
        <Hint>Used by new query consoles. Consoles that are already open keep their mode.</Hint>
      </Section>
    </div>
  );
}

export function DataEditorPage(props: { draft: Draft }) {
  const d = () => props.draft;
  const q = () => d().query();
  // DataGrip keeps the typed limit while the checkbox is off; 0 means "no limit" in the store
  const [lastLimit, setLastLimit] = createSignal(d().values.gridPageSize > 0 ? d().values.gridPageSize : DEFAULT_SETTINGS.gridPageSize);
  const limited = () => d().values.gridPageSize > 0;
  return (
    <div class="st-page">
      <Section title="Limitations" q={q()}>
        <Row field>
          <span class="st-label st-label-wide">
            <Checkbox
              checked={limited()}
              onChange={(c) => d().set("gridPageSize", c ? lastLimit() : 0)}
              label={<L q={q()}>Limit page size to:</L>}
            />
          </span>
          <NumberField
            value={limited() ? d().values.gridPageSize : lastLimit()}
            min={1}
            max={1000000}
            disabled={!limited()}
            onChange={(n) => {
              setLastLimit(n);
              d().set("gridPageSize", n);
            }}
          />
        </Row>
      </Section>
      <Section title="Data Presentation" q={q()}>
        <Row field>
          <span class="st-label st-label-wide">
            <L q={q()}>Display NULL as:</L>
          </span>
          <TextField frameClass="st-null-frame" value={d().values.gridNullText} onInput={(v) => d().set("gridNullText", v)} placeholder={DEFAULT_SETTINGS.gridNullText} />
        </Row>
      </Section>
    </div>
  );
}

/** Link list shown for a group page (DataGrip: `Editor` lists General, Font...). */
export function GroupPage(props: { node: PageNode; open: (id: string) => void }) {
  const kids = (n: PageNode): PageNode[] => n.children ?? [];
  return (
    <div class="st-page st-group">
      <Show when={props.node.description}>
        <p class="st-group-text">{props.node.description}</p>
      </Show>
      <ul class="st-links">
        <For each={kids(props.node)}>
          {(c) => (
            <li>
              <a href="#" onClick={(e) => { e.preventDefault(); props.open(c.id); }}>
                {c.title}
              </a>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
