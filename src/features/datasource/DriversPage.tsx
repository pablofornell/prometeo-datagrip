import { For, Show, createSignal } from "solid-js";
import { Checkbox, Highlighted, Icon, SpeedSearchField, Tabs, TextField, createSpeedSearch, matchRanges } from "../../components/ui";
import { driverDefaults, setDriverDefaults } from "./driverDefaults";
import { DBMS, DBMS_ORDER, type Dbms, dbmsIcon } from "./drivers";
import { LinkButton, Row } from "./widgets";

const URL_TEMPLATE: Record<Dbms, string> = {
  postgres: "jdbc:postgresql://{host::localhost}?[:{port::5432}][/{database}?]",
  mysql: "jdbc:mysql://{host::localhost}?[:{port::3306}][/{database}]",
  mariadb: "jdbc:mariadb://{host::localhost}?[:{port::3306}][/{database}]",
  sqlite: "jdbc:sqlite:{file}",
};

const NOTES: Record<Dbms, string> = {
  postgres: "Built in. Connections use the sqlx PostgreSQL driver; no files to download.",
  mysql: "Built in. Connections use the sqlx MySQL driver; no files to download.",
  mariadb: "Built in. MariaDB servers are reached through the MySQL driver.",
  sqlite: "Built in. SQLite is linked into the application; no files to download.",
};

const TABS = [
  { id: "general", title: "General" },
  { id: "options", title: "Options" },
];

/** "Drivers" page: the built-in drivers (typing filters the list), their info and the defaults new data sources inherit. */
export function DriversPage(props: { initial?: Dbms; onCreate: (dbms: Dbms) => void }) {
  const [sel, setSel] = createSignal<Dbms>(props.initial ?? "postgres");
  const [tab, setTab] = createSignal<"general" | "options">("general");
  const search = createSpeedSearch();
  const info = () => DBMS[sel()];
  const shown = () => DBMS_ORDER.filter((id) => !search.query() || matchRanges(DBMS[id].label, search.query()));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = shown();
      const n = list[list.indexOf(sel()) + (e.key === "ArrowDown" ? 1 : -1)];
      if (n) setSel(n);
    } else if (!search.handleKey(e)) return;
    else {
      // the selection follows the filter
      const list = shown();
      if (list.length && !list.includes(sel())) setSel(list[0]);
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const defaults = () => driverDefaults(sel());
  const change = (patch: Partial<ReturnType<typeof defaults>>) => {
    const next = { ...defaults(), ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
    setDriverDefaults(sel(), next);
    bump((v) => v + 1);
  };
  const [, bump] = createSignal(0);
  const numberRow = (key: "keepAliveSec" | "autoDisconnectSec", label: string, dflt: string) => (
    <div class="ds-opt-row">
      <Checkbox checked={defaults()[key] !== undefined} onChange={(c) => change({ [key]: c ? dflt : undefined })} label={label} />
      <TextField
        value={defaults()[key] ?? dflt}
        disabled={defaults()[key] === undefined}
        onInput={(v) => change({ [key]: v === "" ? "0" : v })}
        frameClass="ds-opt-number"
        inputmode="numeric"
      />
      <span class="ds-opt-after">sec.</span>
    </div>
  );

  return (
    <>
      <div class="ds-left">
        <div class="ds-left-head">
          <span class="ds-left-title">Drivers</span>
        </div>
        <Show when={search.active()}>
          <div class="ds-drivers-searchbar">
            <SpeedSearchField query={search.query()} noMatch={shown().length === 0} />
          </div>
        </Show>
        <div class="ds-list ds-drivers-list" tabindex={0} onKeyDown={onKey}>
          <div class="ds-list-group" classList={{ "ds-list-group-first": true }}>
            Complete Support
          </div>
          <For each={shown()}>
            {(id) => (
              <div class="ds-list-row" classList={{ "ds-selected": sel() === id }} onClick={() => setSel(id)}>
                <Icon src={dbmsIcon(id)} />
                <span class="ds-list-name">
                  <Highlighted text={DBMS[id].label} query={search.query()} />
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="ds-right">
        <div class="ds-form ds-driver-form">
          <Row label="Name:">
            <TextField value={info().label} readOnly frameClass="ds-fill" />
          </Row>
          <div class="ds-tabbar ds-driver-tabs">
            <Tabs variant="dialog" items={TABS} active={tab()} onSelect={(id) => setTab(id as "general" | "options")} />
          </div>
          <Show when={tab() === "general"}>
            <Row label="Library:">
              <TextField value={info().library} readOnly frameClass="ds-fill" />
            </Row>
            <Row label="URL template:">
              <TextField value={URL_TEMPLATE[sel()]} readOnly frameClass="ds-fill" />
            </Row>
            <Row label="Default port:">
              <TextField value={info().defaultPort ? String(info().defaultPort) : "-"} readOnly frameClass="ds-port" />
            </Row>
            <Row label="SSL modes:">
              <TextField value={info().sslModes.map((m) => m.label).join(", ") || "-"} readOnly frameClass="ds-fill" />
            </Row>
            <div class="ds-hint ds-driver-note">{NOTES[sel()]}</div>
          </Show>
          <Show when={tab() === "options"}>
            <div class="ds-hint ds-driver-note">New {info().label} data sources start with these settings.</div>
            <div class="ds-driver-options">
              <div class="ds-opt-row">
                <Checkbox
                  checked={defaults().txMode === "manual"}
                  onChange={(c) => change({ txMode: c ? "manual" : undefined })}
                  label="Manual transaction control"
                />
              </div>
              {numberRow("keepAliveSec", "Run keep-alive query each", "60")}
              {numberRow("autoDisconnectSec", "Auto-disconnect after", "300")}
            </div>
          </Show>
        </div>
        <div class="ds-driver-foot">
          <LinkButton onClick={() => props.onCreate(sel())}>Create Data Source</LinkButton>
        </div>
      </div>
    </>
  );
}
