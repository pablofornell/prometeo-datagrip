import { For, createSignal } from "solid-js";
import { Icon, TextField } from "../../components/ui";
import { DBMS, DBMS_ORDER, type Dbms, dbmsIcon } from "./drivers";
import { Row } from "./widgets";

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

/** Read-only "Drivers" page: the built-in drivers and their settings. */
export function DriversPage() {
  const [sel, setSel] = createSignal<Dbms>("postgres");
  const info = () => DBMS[sel()];
  return (
    <>
      <div class="ds-left">
        <div class="ds-left-head">
          <span class="ds-left-title">Drivers</span>
        </div>
        <div class="ds-list ds-drivers-list">
          <For each={DBMS_ORDER}>
            {(id) => (
              <div class="ds-list-row" classList={{ "ds-selected": sel() === id }} onClick={() => setSel(id)}>
                <Icon src={dbmsIcon(id)} />
                <span class="ds-list-name">{DBMS[id].label}</span>
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
        </div>
      </div>
    </>
  );
}
