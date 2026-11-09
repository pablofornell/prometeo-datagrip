/** The Settings pages (operative ones only). Every page edits the dialog's draft, never the live settings. */
import { For, Show, createSignal } from "solid-js";
import { Checkbox, ComboBox, Icon, TextField } from "../../components/ui";
import { SqlEditor } from "../../components/editor";
import { DEFAULT_SETTINGS } from "../../state/settings";
import { SCHEME_LABEL, type SchemeId } from "../../state/colorScheme";
import type { ThemePref } from "../../state/theme";
import type { PageNode } from "./model";
import { Hint, L, NumberField, Row, Section, type Draft, draftScheme, draftTheme } from "./widgets";

export function AppearancePage(props: { draft: Draft; open: (id: string) => void }) {
  const d = () => props.draft;
  const q = () => d().query();
  const uiTheme = () => draftTheme(d());
  const scheme = () => draftScheme(d());
  const check = (key: "compactMode" | "projectColors" | "menuIcons" | "treeIndentGuides" | "treeSmallIndents", label: string) => (
    <Checkbox checked={d().values[key]} onChange={(c) => d().set(key, c)} label={<L q={q()}>{label}</L>} />
  );
  return (
    <div class="st-page">
      <Row field class="st-row-first">
        <span class="st-label">
          <L q={q()}>Theme:</L>
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
      <Row field class="st-row-indent">
        <span class="st-label">
          <L q={q()}>Editor color scheme:</L>
        </span>
        <ComboBox<SchemeId>
          width={193}
          value={scheme()}
          onChange={(s) => d().set("editorScheme", s === uiTheme() ? "auto" : s)}
          options={(["dark", "light"] as SchemeId[]).map((s) => ({ value: s, label: SCHEME_LABEL[s] }))}
        />
        <button type="button" class="st-tool" title="Color Scheme Settings" aria-label="Color Scheme Settings" onClick={() => props.open("editor.color-scheme.sql")}>
          <Icon name="settings" />
        </button>
      </Row>
      <Row field>
        <Checkbox checked={d().values.uiCustomFont} onChange={(c) => d().set("uiCustomFont", c)} label={<L q={q()}>Use custom font:</L>} />
        <ComboBox<"inter" | "system">
          width={266}
          disabled={!d().values.uiCustomFont}
          value={d().values.uiFontFamily}
          onChange={(f) => d().set("uiFontFamily", f)}
          options={[
            { value: "inter", label: "Inter" },
            { value: "system", label: "System default" },
          ]}
        />
        <span class="st-label st-label-inline" classList={{ "st-muted": !d().values.uiCustomFont }}>
          <L q={q()}>Size:</L>
        </span>
        <NumberField narrow disabled={!d().values.uiCustomFont} value={d().values.uiFontSize} min={9} max={24} step={1} onChange={(n) => d().set("uiFontSize", n)} />
      </Row>
      <Hint>The size scales the whole window (13 is 100 %).</Hint>
      <Section title="UI Options" q={q()}>
        <Row>{check("compactMode", "Compact mode")}</Row>
        <Hint>UI elements take up less screen space</Hint>
        <Row class="st-row-gap">{check("projectColors", "Use project colors in main toolbar")}</Row>
        <Hint>Distinguish projects with different toolbar colors at a glance.</Hint>
        <Row class="st-row-gap">{check("menuIcons", "Display icons in menu items")}</Row>
      </Section>
      <Section title="Tree Views" q={q()}>
        <div class="st-two-col">
          <Row>{check("treeIndentGuides", "Show indent guides")}</Row>
          <Row>{check("treeSmallIndents", "Use smaller indents")}</Row>
        </div>
      </Section>
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
        <Row>
          <Checkbox
            checked={d().values.editorIndentGuides}
            onChange={(c) => d().set("editorIndentGuides", c)}
            label={<L q={d().query()}>Show indent guides</L>}
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
      <Section title="Execute" q={d().query()}>
        <Row field>
          <span class="st-label st-label-wide">
            <L q={d().query()}>When caret inside statement execute:</L>
          </span>
          <ComboBox<"ask" | "smallest" | "largest">
            width={210}
            value={d().values.execCaretInside}
            onChange={(m) => d().set("execCaretInside", m)}
            options={[
              { value: "ask", label: "Ask what to execute" },
              { value: "smallest", label: "Smallest statement" },
              { value: "largest", label: "Largest statement" },
            ]}
          />
        </Row>
        <Hint>Applies when the statement has a comment attached above it: the statement alone is the smallest, with its comment the largest.</Hint>
      </Section>
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
        <Row>
          <Checkbox checked={d().values.gridAlternateRows} onChange={(c) => d().set("gridAlternateRows", c)} label={<L q={q()}>Alternate row colors</L>} />
        </Row>
      </Section>
    </div>
  );
}

export function CodeStyleSqlPage(props: { draft: Draft }) {
  const d = () => props.draft;
  return (
    <div class="st-page">
      <Section title="Letter Case" q={d().query()}>
        <Row field>
          <span class="st-label st-label-wide">
            <L q={d().query()}>Keywords case:</L>
          </span>
          <ComboBox<"keep" | "upper" | "lower">
            width={160}
            value={d().values.sqlKeywordCase}
            onChange={(m) => d().set("sqlKeywordCase", m)}
            options={[
              { value: "keep", label: "Do not change" },
              { value: "upper", label: "To upper case" },
              { value: "lower", label: "To lower case" },
            ]}
          />
        </Row>
        <Hint>Applied by Reformat Code (Ctrl+Alt+L) to reserved words; names, strings and comments are not touched.</Hint>
      </Section>
      <Section title="Completion" q={d().query()}>
        <Row>
          <Checkbox checked={d().values.sqlInsertTableAlias} onChange={(c) => d().set("sqlInsertTableAlias", c)} label={<L q={d().query()}>Insert table alias</L>} />
        </Row>
        <Hint>When a table is completed after FROM or JOIN, an alias is added automatically.</Hint>
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
