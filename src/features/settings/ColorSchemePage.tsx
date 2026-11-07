/**
 * Editor > Color Scheme > SQL: the scheme chooser, the list of SQL attributes with their options, and a live preview.
 * Edits go to the dialog's draft (`colorOverrides` per scheme); the preview shows the draft at once, the editors of the
 * app follow on OK / Apply (see `applyAppearance` in state/settings.ts).
 */
import { For, createMemo, createSignal, onCleanup } from "solid-js";
import { Checkbox, ComboBox, Icon, openMenu } from "../../components/ui";
import { SqlEditor } from "../../components/editor";
import type { SchemaSnapshot } from "../../components/editor";
import {
  type AttrOverride,
  EFFECTS,
  type EffectKind,
  SCHEME_ATTRS,
  SCHEME_LABEL,
  type SchemeAttr,
  type SchemeId,
  attrBaseFg,
  baseColor,
  isEmptyOverride,
  patchOverride,
  schemeRules,
  schemeVars,
} from "../../state/colorScheme";
import { ColorField, type Draft, draftScheme, draftTheme } from "./widgets";

const PREVIEW = `-- DDL section
create table crm.product (
  id numeric primary key,
  title varchar(255) character set utf8
);
-- DML section
insert into product
  values (1, 'Product1');

select count(*) from crm.product;
select id as ProductID, title as ProductName
  from crm.product where id = $1;
select missing from crm.product;
`;

const SCHEMA: SchemaSnapshot = {
  schemas: [
    {
      name: "crm",
      tables: [
        {
          name: "product",
          kind: "table",
          columns: [
            { name: "id", type: "numeric", key: "pk" },
            { name: "title", type: "varchar(255)" },
          ],
        },
      ],
    },
  ],
};

export function ColorSchemePage(props: { draft: Draft; open: (id: string) => void }) {
  const d = () => props.draft;
  const uiTheme = () => draftTheme(d());
  const scheme = () => draftScheme(d());
  const edits = () => d().values.colorOverrides[scheme()];
  const [sel, setSel] = createSignal(SCHEME_ATTRS[0].id);
  const [flash, setFlash] = createSignal<string | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(flashTimer));

  const attr = (): SchemeAttr => SCHEME_ATTRS.find((a) => a.id === sel()) ?? SCHEME_ATTRS[0];
  const own = (): AttrOverride | undefined => edits()[attr().id];
  const inherit = () => isEmptyOverride(own());

  const select = (id: string) => {
    setSel(id);
    setFlash(id);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setFlash(null), 2000);
  };
  const setEdits = (next: Record<string, AttrOverride>) => d().set("colorOverrides", { ...d().values.colorOverrides, [scheme()]: next });
  const patch = (p: Partial<AttrOverride>) => setEdits(patchOverride(edits(), attr().id, p));
  const clearAttr = () => {
    const next = { ...edits() };
    delete next[attr().id];
    setEdits(next);
  };

  const baseFg = () => attrBaseFg(attr(), scheme());
  const baseBg = () => baseColor(scheme(), "--dg-editor-bg") ?? "#FFFFFF";
  const fg = () => own()?.fg ?? baseFg();
  const isItalic = () => own()?.italic ?? attr().italic?.(scheme()) ?? false;

  const schemeOptions = createMemo(() =>
    (["dark", "light"] as SchemeId[]).map((s) => ({ value: s, label: SCHEME_LABEL[s] + (s === uiTheme() ? "  Theme default" : "") })),
  );

  // the preview wears the draft: the scheme's token family, the foreground edits and the remaining properties
  const previewVars = createMemo(() => schemeVars(scheme(), uiTheme(), edits()));
  const rules = createMemo(() => {
    const a = SCHEME_ATTRS.find((x) => x.id === flash());
    const blink = a ? `.st-cs-preview .sql-editor .${a.cls}{outline:1px solid var(--dg-editor-fg);outline-offset:-1px;animation:st-blink .5s steps(1) 4}` : "";
    return schemeRules(edits(), [".st-cs-preview .sql-editor"]) + "\n" + blink;
  });

  const onPreviewClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest?.(".cm-sql-kw,.cm-sql-str,.cm-sql-num,.cm-sql-cmt,.cm-sql-fn,.cm-sql-col,.cm-sql-bad,.cm-sql-param");
    const a = el && SCHEME_ATTRS.find((x) => el.classList.contains(x.cls));
    if (a) select(a.id);
  };

  return (
    <div class="st-page st-cs">
      <div class="st-cs-head">
        <span class="st-label">Scheme:</span>
        <ComboBox<SchemeId>
          width={236}
          value={scheme()}
          options={schemeOptions()}
          onChange={(s) => d().set("editorScheme", s === uiTheme() ? "auto" : s)}
        />
        <button
          type="button"
          class="st-tool"
          title="Scheme actions"
          aria-label="Scheme actions"
          onClick={(e) =>
            openMenu(
              [
                { label: "Reset", enabled: Object.keys(edits()).length > 0, run: () => setEdits({}) },
                { label: "Reset Selected Attribute", enabled: !inherit(), run: clearAttr },
              ],
              { anchor: e.currentTarget },
            )
          }
        >
          <Icon name="settings" />
        </button>
        <a
          href="#"
          class="st-cs-link"
          onClick={(e) => {
            e.preventDefault();
            props.open("appearance");
          }}
        >
          Change IDE Theme…
        </a>
      </div>
      <div class="st-cs-main">
        <div class="st-cs-list" role="listbox" aria-label="SQL attributes">
          <For each={SCHEME_ATTRS}>
            {(a) => (
              <div class="st-cs-attr" classList={{ "st-selected": a.id === sel(), "st-cs-edited": !isEmptyOverride(edits()[a.id]) }} role="option" aria-selected={a.id === sel()} data-attr={a.id} onClick={() => select(a.id)}>
                {a.label}
              </div>
            )}
          </For>
        </div>
        <div class="st-cs-opts">
          <div class="st-cs-opt-row">
            <Checkbox checked={own()?.bold ?? false} disabled={inherit()} onChange={(c) => patch({ bold: c })} label="Bold" />
            <Checkbox checked={isItalic()} disabled={inherit()} onChange={(c) => patch({ italic: c })} label="Italic" />
          </div>
          <div class="st-cs-opt-row st-cs-color">
            <Checkbox checked={own()?.fg !== undefined} disabled={inherit()} onChange={(c) => patch({ fg: c ? fg() : undefined })} label="Foreground" />
            <ColorField value={own()?.fg} fallback={baseFg()} disabled={inherit() || own()?.fg === undefined} onChange={(c) => patch({ fg: c })} />
          </div>
          <div class="st-cs-opt-row st-cs-color">
            <Checkbox checked={own()?.bg !== undefined} disabled={inherit()} onChange={(c) => patch({ bg: c ? baseBg() : undefined })} label="Background" />
            <ColorField value={own()?.bg} fallback={baseBg()} disabled={inherit() || own()?.bg === undefined} onChange={(c) => patch({ bg: c })} />
          </div>
          <div class="st-cs-opt-row st-cs-color">
            <Checkbox
              checked={own()?.effect !== undefined}
              disabled={inherit()}
              onChange={(c) => patch(c ? { effect: "box", effectColor: fg() } : { effect: undefined, effectColor: undefined })}
              label="Effects"
            />
            <ColorField value={own()?.effectColor} fallback={fg()} disabled={inherit() || own()?.effect === undefined} onChange={(c) => patch({ effectColor: c })} />
          </div>
          <div class="st-cs-opt-row st-cs-effect">
            <ComboBox<EffectKind>
              width={160}
              value={own()?.effect ?? "box"}
              disabled={inherit() || own()?.effect === undefined}
              options={EFFECTS}
              onChange={(v) => patch({ effect: v })}
            />
          </div>
          <div class="st-cs-inherit">
            <Checkbox
              checked={inherit()}
              onChange={(c) => (c ? clearAttr() : patch({ fg: baseFg() }))}
              label="Inherit values from:"
            />
            <div class="st-cs-inherit-from">
              <span class="st-cs-link">{attr().inherits}</span>
              <br />
              (Language Defaults)
            </div>
          </div>
        </div>
      </div>
      <div class="st-cs-preview" style={previewVars()} onClick={onPreviewClick}>
        <style>{rules()}</style>
        <SqlEditor
          value={PREVIEW}
          dialect="postgres"
          schema={SCHEMA}
          readOnly
          gutter={false}
          stripe={false}
          statementFrame={false}
        />
      </div>
    </div>
  );
}
