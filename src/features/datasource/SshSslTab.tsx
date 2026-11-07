import { isTauri } from "../../api/db";
import { Checkbox, ComboBox, TextField, notify } from "../../components/ui";
import { DBMS } from "./drivers";

const PREVIEW_MODES = DBMS.postgres.sslModes;
import type { Session } from "./session";
import { FileField, Row } from "./widgets";

/** Picks a certificate / key file with the desktop file chooser. */
async function browseCert(title: string, onPick: (path: string) => void) {
  if (!isTauri()) {
    notify({ title: "File chooser", body: "The file chooser is available in the desktop app. Type the path instead.", kind: "info" });
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ multiple: false, directory: false, title });
    if (typeof p === "string") onPick(p);
  } catch (e) {
    notify({ title: "File chooser", body: String(e), kind: "error" });
  }
}

/** SSH tunnel (not supported by the backend yet) and SSL (`options.sslmode`, `sslrootcert`, `sslcert`, `sslkey`). */
export function SshSslTab(props: { s: Session }) {
  const s = props.s;
  const f = () => s.current()!.form;
  const info = () => DBMS[f().dbms];
  const sslOn = () => f().options.sslmode !== undefined;
  const canSsl = () => f().dbms !== "sqlite" && f().dbms !== "oracle" && f().connType !== "url";

  return (
    <div class="ds-form ds-ssh">
      <div class="ds-ssh-check">
        <Checkbox disabled label="Use SSH tunnel" />
      </div>
      <Row label="SSH configuration:" labelWidth={125} disabled>
        <div class="ds-ssh-combo">
          <ComboBox disabled placeholder="<create configuration>" options={[]} />
        </div>
        <span class="ds-ssh-btn">...</span>
      </Row>
      <Row label="Local port:" labelWidth={125} disabled>
        <TextField disabled placeholder="<Dynamic>" frameClass="ds-local-port" />
      </Row>
      <div class="ds-hint ds-hint-ssh">SSH tunnels are not supported yet</div>
      <hr class="ds-sep" />

      <div class="ds-ssh-check ds-ssl-check">
        <Checkbox
          checked={sslOn()}
          disabled={!canSsl()}
          onChange={(c) => s.setOption("sslmode", c ? info().defaultSslMode : undefined)}
          label="Use SSL"
        />
      </div>
      {(
        [
          ["CA file:", "sslrootcert", "Select CA File"],
          ["Client certificate file:", "sslcert", "Select Client Certificate File"],
          ["Client key file:", "sslkey", "Select Client Key File"],
        ] as const
      ).map(([label, key, title]) => (
        <Row label={label} labelWidth={139} disabled={!sslOn()}>
          <FileField
            value={f().options[key] ?? ""}
            disabled={!sslOn()}
            onInput={(v) => s.setOption(key, v)}
            onBrowse={() => void browseCert(title, (p) => s.setOption(key, p))}
          />
        </Row>
      ))}
      <Row label="Mode:" labelWidth={139} disabled={!sslOn()}>
        <div class="ds-ssl-mode">
          <ComboBox
            disabled={!sslOn()}
            value={f().options.sslmode ?? (info().defaultSslMode || "require")}
            options={info().sslModes.length ? info().sslModes : PREVIEW_MODES}
            onChange={(v) => s.setOption("sslmode", v)}
          />
        </div>
      </Row>
      <div class="ds-hint ds-hint-ssl">
        {f().dbms === "sqlite"
          ? "SSL does not apply to SQLite"
          : f().dbms === "oracle"
            ? "SSL (TCPS) is not supported for Oracle yet"
            : f().connType === "url"
              ? "In URL only mode set the SSL parameters in the URL"
              : "The CA file is used by the Verify modes; the client files only when the server asks for a certificate"}
      </div>
    </div>
  );
}
