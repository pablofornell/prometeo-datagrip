import { Checkbox, ComboBox, Icon, TextField } from "../../components/ui";
import { DBMS } from "./drivers";

const PREVIEW_MODES = DBMS.postgres.sslModes;
import type { Session } from "./session";
import { Row } from "./widgets";

/** SSH tunnel (not supported by the backend yet) and SSL (sslmode is wired through `options.sslmode`). */
export function SshSslTab(props: { s: Session }) {
  const s = props.s;
  const f = () => s.current()!.form;
  const info = () => DBMS[f().dbms];
  const sslOn = () => f().options.sslmode !== undefined;
  const canSsl = () => f().dbms !== "sqlite" && f().connType !== "url";

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
      <Row label="CA file:" labelWidth={139} disabled>
        <TextField disabled frameClass="ds-fill" suffix={<Icon name="folder" />} />
      </Row>
      <Row label="Client certificate file:" labelWidth={139} disabled>
        <TextField disabled frameClass="ds-fill" suffix={<Icon name="folder" />} />
      </Row>
      <Row label="Client key file:" labelWidth={139} disabled>
        <TextField disabled frameClass="ds-fill" suffix={<Icon name="folder" />} />
      </Row>
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
          : f().connType === "url"
            ? "In URL only mode set the SSL parameters in the URL"
            : "Certificate files are not supported yet"}
      </div>
    </div>
  );
}
