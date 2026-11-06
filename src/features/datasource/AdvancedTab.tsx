import { For, Show, createSignal } from "solid-js";
import { Icon, tip } from "../../components/ui";
import type { Dbms } from "./drivers";
import { RESERVED_OPTIONS } from "./model";
import type { Session } from "./session";

interface KnownProp {
  name: string;
  description: string;
}

/** Driver properties dbcore reads from `DataSourceConfig.options` (see crates/dbcore/src/conn.rs). */
const KNOWN: Record<Dbms, KnownProp[]> = {
  postgres: [
    { name: "application_name", description: "Name of the client shown in pg_stat_activity. Default: Prometeo DataGrip." },
    { name: "connectTimeout", description: "Seconds to wait while connecting. Default: 15." },
  ],
  mysql: [{ name: "connectTimeout", description: "Seconds to wait while connecting. Default: 15." }],
  mariadb: [{ name: "connectTimeout", description: "Seconds to wait while connecting. Default: 15." }],
  sqlite: [{ name: "connectTimeout", description: "Seconds to wait while opening the pool. Default: 15." }],
};

export function AdvancedTab(props: { s: Session }) {
  const s = props.s;
  const f = () => s.current()!.form;
  const known = () => KNOWN[f().dbms];
  const knownNames = () => new Set(known().map((k) => k.name));
  const custom = () => Object.keys(f().options).filter((k) => !RESERVED_OPTIONS.has(k) && !knownNames().has(k)).sort();
  const [hint, setHint] = createSignal("Property description.");
  const [sortDesc, setSortDesc] = createSignal(false);

  const rows = () => {
    const all = [...known().map((k) => ({ name: k.name, desc: k.description, custom: false })), ...custom().map((n) => ({ name: n, desc: "", custom: true }))];
    // known first as DataGrip lists everything alphabetically
    all.sort((a, b) => (sortDesc() ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
    return all;
  };

  const addProperty = () => {
    let n = "property";
    for (let i = 2; f().options[n] !== undefined || knownNames().has(n); i++) n = `property${i}`;
    // an empty value is not stored, so a new row starts with a placeholder value
    s.setOption(n, "value");
    setTimeout(() => document.querySelector<HTMLInputElement>(`.ds-adv-name[data-key="${n}"]`)?.select(), 0);
  };

  return (
    <div class="ds-advanced">
      <div class="ds-adv-table">
        <div class="ds-adv-head">
          <div class="ds-adv-col-name" onClick={() => setSortDesc(!sortDesc())}>
            Name <Icon name={sortDesc() ? "chevron-down" : "chevron-up"} />
          </div>
          <div class="ds-adv-col-value">Value</div>
        </div>
        <div class="ds-adv-body">
          <For each={rows()}>
            {(r) => (
              <div class="ds-adv-row" onMouseEnter={() => setHint(r.desc || "Custom driver property.")}>
                <div class="ds-adv-col-name" classList={{ "ds-adv-bold": f().options[r.name] !== undefined }}>
                  <Show when={r.custom} fallback={<span>{r.name}</span>}>
                    <input
                      class="ds-adv-name"
                      data-key={r.name}
                      spellcheck={false}
                      value={r.name}
                      onChange={(e) => {
                        const to = e.currentTarget.value.trim();
                        if (!to || to === r.name || RESERVED_OPTIONS.has(to) || knownNames().has(to) || f().options[to] !== undefined) {
                          e.currentTarget.value = r.name;
                          return;
                        }
                        s.renameOption(r.name, to);
                      }}
                    />
                  </Show>
                </div>
                <div class="ds-adv-col-value">
                  <input
                    class="ds-adv-value"
                    classList={{ "ds-adv-bold": f().options[r.name] !== undefined }}
                    spellcheck={false}
                    value={f().options[r.name] ?? ""}
                    onChange={(e) => s.setOption(r.name, e.currentTarget.value)}
                  />
                  <Show when={r.custom}>
                    <span class="ds-adv-remove" {...tip("Remove property")} onClick={() => s.setOption(r.name, undefined)}>
                      <Icon name="close-small" />
                    </span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="ds-adv-footer">
        <div class="ds-adv-desc">{hint()}</div>
        <button type="button" class="ds-link" onClick={addProperty}>
          Add property
        </button>
      </div>
    </div>
  );
}
