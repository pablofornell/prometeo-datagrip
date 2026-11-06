import { Show } from "solid-js";
import { isTauri } from "../../api/db";
import { Checkbox, ComboBox, Icon, TextField, notify, openMenu } from "../../components/ui";
import { DBMS, DBMS_ORDER, type Dbms, dbmsIcon, parseUrl } from "./drivers";
import { listDatabases } from "./remote";
import type { Session } from "./session";
import { EditableCombo, FileField, Row, Segmented } from "./widgets";

async function browseFile(onPick: (path: string) => void) {
  if (!isTauri()) {
    notify({ title: "File chooser", body: "The file chooser is available in the desktop app. Type the path instead.", kind: "info" });
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({
      multiple: false,
      directory: false,
      title: "Select SQLite Database File",
      filters: [
        { name: "SQLite databases", extensions: ["db", "sqlite", "sqlite3", "db3", "s3db", "sl3"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof p === "string") onPick(p);
  } catch (e) {
    notify({ title: "File chooser", body: String(e), kind: "error" });
  }
}

const SAVE_OPTIONS = [
  { value: "forever", label: "Forever", enabled: true },
  { value: "session", label: "Until restart", enabled: false },
  { value: "never", label: "Never", enabled: false },
];

export function GeneralTab(props: { s: Session }) {
  const s = props.s;
  const d = () => s.current()!;
  const f = () => d().form;
  const dbms = () => f().dbms;
  const isSqlite = () => dbms() === "sqlite";
  const urlInvalid = () => f().connType !== "memory" && !parseUrl(dbms(), f().url);

  const connTypes = () =>
    isSqlite()
      ? [
          { value: "default" as const, label: "default" },
          { value: "memory" as const, label: "In-memory" },
          { value: "url" as const, label: "URL only" },
        ]
      : [
          { value: "default" as const, label: "default" },
          { value: "url" as const, label: "URL only" },
        ];

  const dbSuggestions = async (): Promise<string[]> => {
    const saved = d().id && !s.isModified(d());
    if (saved) return listDatabases(d().id!);
    return dbms() === "postgres" ? ["postgres"] : [];
  };

  let saveBtn!: HTMLButtonElement;
  const openSaveMenu = () =>
    openMenu(
      SAVE_OPTIONS.map((o) => ({ label: o.label, checked: o.value === "forever", enabled: o.enabled, run: () => undefined })),
      { anchor: saveBtn, compact: true, minWidth: saveBtn.offsetWidth },
    );

  return (
    <div class="ds-form">
      <Row label="Driver:" class="ds-row-driver">
        <ComboBox<Dbms>
          value={dbms()}
          options={DBMS_ORDER.map((id) => ({ value: id, label: DBMS[id].label, icon: dbmsIcon(id) }))}
          onChange={(v) => s.setDbms(v)}
        />
      </Row>

      <Row label="Connection type:" class="ds-row-conntype">
        <Segmented options={connTypes()} value={f().connType} onChange={(v) => s.setConnType(v)} />
      </Row>

      {/* ---- SQLite */}
      <Show when={isSqlite() && f().connType === "default"}>
        <Row label="File:" class="ds-row-main">
          <FileField
            value={f().file}
            onInput={(v) => s.setField("file", v)}
            onBrowse={() => void browseFile((p) => s.setField("file", p))}
          />
        </Row>
        <div class="ds-create-row">
          <Checkbox
            checked={f().options.create === "true"}
            onChange={(c) => s.setOption("create", c ? "true" : undefined)}
            label="Create the file if it does not exist"
          />
        </div>
      </Show>

      {/* ---- PostgreSQL / MySQL */}
      <Show when={!isSqlite() && f().connType === "default"}>
        <Row label="Host:" class="ds-row-main">
          <TextField value={f().host} onInput={(v) => s.setField("host", v)} frameClass="ds-fill" />
          <span class="ds-sublabel">Port:</span>
          <TextField value={f().port} onInput={(v) => s.setField("port", v)} frameClass="ds-port" />
        </Row>
        <Row label="Authentication:" class="ds-row-auth">
          <ComboBox
            value={f().auth}
            options={[
              { value: "password", label: "User & Password" },
              { value: "none", label: "No auth" },
            ]}
            onChange={(v) => s.setField("auth", v as "password" | "none")}
          />
        </Row>
        <Show when={f().auth === "password"}>
          <Row label="User:" class="ds-row-user">
            <TextField value={f().user} onInput={(v) => s.setField("user", v)} frameClass="ds-fill" />
          </Row>
          <Row label="Password:" class="ds-row-pass">
            <TextField
              type="password"
              value={d().password.value}
              placeholder="<hidden>"
              onInput={(v) => s.setPassword(v)}
              frameClass="ds-fill"
              autocomplete="new-password"
            />
            <span class="ds-sublabel">Save:</span>
            <button type="button" ref={saveBtn} class="dg-combo ds-save-combo" onClick={openSaveMenu}>
              <span class="dg-combo-text">Forever</span>
              <span class="dg-combo-arrow">
                <Icon name="chevron-down" />
              </span>
            </button>
          </Row>
        </Show>
        <Row label="Database:" class="ds-row-db">
          <EditableCombo value={f().database} onInput={(v) => s.setField("database", v)} suggestions={dbSuggestions} />
        </Row>
      </Show>

      {/* ---- URL only */}
      <Show when={f().connType === "url"}>
        <Row label="URL:" class="ds-row-main">
          <TextField value={f().url} onInput={(v) => s.setUrl(v)} error={urlInvalid()} frameClass="ds-fill" />
        </Row>
        <div class="ds-hint ds-hint-url">
          {isSqlite()
            ? "jdbc:sqlite:<path to the database file>"
            : `Include the credentials in the URL: jdbc:${DBMS[dbms()].scheme}://host:port/database?user=name&password=secret`}
        </div>
      </Show>

      {/* ---- derived URL */}
      <Show when={f().connType !== "url"}>
        <Row label="URL:" class="ds-row-url">
          <input
            class="ds-url"
            classList={{ "ds-url-error": urlInvalid() }}
            spellcheck={false}
            value={f().url}
            readOnly={f().connType === "memory"}
            onInput={(e) => s.setUrl(e.currentTarget.value)}
          />
        </Row>
        <Show when={f().connType === "default"}>
          <div class="ds-hint ds-hint-below-url">Overrides settings above</div>
        </Show>
      </Show>
    </div>
  );
}
