import { For, Show, createSignal } from "solid-js";
import { Icon, tip } from "../../components/ui";
import type { Dbms } from "./drivers";
import { RESERVED_OPTIONS } from "./model";
import type { Session } from "./session";

interface KnownProp {
  name: string;
  description: string;
}

/** Driver properties dbcore reads from `DataSourceConfig.options` (`build_opts` in crates/dbcore/src/conn.rs). */
const CONNECT_TIMEOUT = { name: "connectTimeout", description: "Seconds to wait while connecting. Default: 15." };
const MYSQL: KnownProp[] = [
  { name: "charset", description: "Character set of the connection (SET NAMES). Default: utf8mb4." },
  { name: "collation", description: "Collation of the connection, e.g. utf8mb4_unicode_ci. Default: the server's for the character set." },
  CONNECT_TIMEOUT,
  { name: "timezone", description: "Session time zone, e.g. +00:00 or Europe/Madrid. Default: not set (values show as the server stores them)." },
];

const KNOWN: Record<Dbms, KnownProp[]> = {
  postgres: [
    { name: "application_name", description: "Name of the client shown in pg_stat_activity. Default: Prometeo DataGrip." },
    CONNECT_TIMEOUT,
    { name: "options", description: "Command-line options sent at start-up, like libpq: -c search_path=sales -c lock_timeout=5000." },
    { name: "statement_timeout", description: "Milliseconds after which the server cancels a statement. 0 = no limit. Default: the server's." },
  ],
  mysql: MYSQL,
  mariadb: MYSQL,
  oracle: [CONNECT_TIMEOUT],
  sqlite: [
    { name: "busy_timeout", description: "Milliseconds to wait for a locked database before failing. Default: 5000." },
    { ...CONNECT_TIMEOUT, description: "Seconds to wait while opening the pool. Default: 15." },
    { name: "foreign_keys", description: "true / false: enforce foreign keys. Default: true." },
    { name: "journal_mode", description: "delete, truncate, persist, memory, wal or off. Default: the database's." },
    { name: "synchronous", description: "off, normal, full or extra: how hard SQLite syncs to disk. Default: full." },
  ],
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
