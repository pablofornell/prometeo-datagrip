import type { JSX } from "solid-js";
import { Checkbox, ComboBox, Icon, TextField, openMenu } from "../../components/ui";
import type { Session } from "./session";

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="ds-section">
      <div class="ds-section-title">
        <span>{props.title}</span>
        <hr />
      </div>
      {props.children}
    </div>
  );
}

/** Borderless "Auto ⌄" style dropdown. */
function LinkCombo(props: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  let btn!: HTMLButtonElement;
  return (
    <button
      type="button"
      ref={btn}
      class="ds-linkcombo"
      onClick={() =>
        openMenu(
          props.options.map((o) => ({ label: o.label, checked: o.value === props.value, run: () => props.onChange(o.value) })),
          { anchor: btn, compact: true, minWidth: 100 },
        )
      }
    >
      <span>{props.options.find((o) => o.value === props.value)?.label}</span>
      <Icon name="chevron-down" />
    </button>
  );
}

export function OptionsTab(props: { s: Session }) {
  const s = props.s;
  const f = () => s.current()!.form;
  const o = (k: string) => f().options[k];
  const numberRow = (key: string, label: string, dflt: string, after = "sec.") => (
    <div class="ds-opt-row">
      <Checkbox checked={o(key) !== undefined} onChange={(c) => s.setOption(key, c ? dflt : undefined)} label={label} />
      <TextField
        value={o(key) ?? dflt}
        disabled={o(key) === undefined}
        onInput={(v) => s.setOption(key, v === "" ? "0" : v)}
        frameClass="ds-opt-number"
        inputmode="numeric"
      />
      <span class="ds-opt-after">{after}</span>
    </div>
  );

  return (
    <div class="ds-scroll ds-options">
      <Section title="Connection">
        <div class="ds-opt-row">
          <Checkbox checked={f().readOnly} onChange={(c) => s.setField("readOnly", c)} label="Read-only" />
        </div>
        <div class="ds-opt-row">
          <span class="ds-opt-label">Transaction control:</span>
          <LinkCombo
            value={o("txMode") ?? "auto"}
            options={[
              { value: "auto", label: "Auto" },
              { value: "manual", label: "Manual" },
            ]}
            onChange={(v) => s.setOption("txMode", v === "auto" ? undefined : v)}
          />
        </div>
        {numberRow("keepAliveSec", "Run keep-alive query each", "60")}
        {numberRow("autoDisconnectSec", "Auto-disconnect after", "300")}
        <div class="ds-opt-row">
          <span class="ds-opt-label">Session control:</span>
          <div class="ds-opt-combo">
            <ComboBox
              value={o("sessionControl") ?? "dedicated"}
              options={[
                { value: "dedicated", label: "Dedicated sessions" },
                { value: "single", label: "Single session" },
              ]}
              onChange={(v) => s.setOption("sessionControl", v === "dedicated" ? undefined : v)}
            />
          </div>
        </div>
        <div class="ds-opt-row ds-opt-top">
          <span class="ds-opt-label">Startup script:</span>
          <textarea
            class="ds-textarea"
            spellcheck={false}
            rows={1}
            value={o("startupScript") ?? ""}
            onInput={(e) => s.setOption("startupScript", e.currentTarget.value)}
          />
        </div>
      </Section>
      <Section title="Introspection">
        <div class="ds-opt-row">
          <Checkbox
            checked={o("showSystemSchemas") === "true"}
            onChange={(c) => s.setOption("showSystemSchemas", c ? "true" : undefined)}
            label="Show system schemas"
          />
        </div>
      </Section>
    </div>
  );
}

