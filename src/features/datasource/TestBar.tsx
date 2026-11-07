import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { isTauri } from "../../api/db";
import { Icon } from "../../components/ui";
import { DBMS, type Dbms } from "./drivers";
import { type TestInfo, shortVersion } from "./model";
import type { Session } from "./session";
import { LinkButton } from "./widgets";

const CASE: Record<Dbms, string> = {
  postgres: "plain=lower, delimited=exact",
  mysql: "plain=exact, delimited=exact",
  mariadb: "plain=exact, delimited=exact",
  oracle: "plain=upper, delimited=exact",
  sqlite: "plain=mixed, delimited=mixed",
};

/** "Driver:" line of the balloon: the library behind each DBMS (`DBMS[x].library` has the full text of the Drivers page). */
const DRIVER_LINE: Record<Dbms, string> = {
  postgres: "sqlx PostgreSQL (ver. 0.8)",
  mysql: "sqlx MySQL (ver. 0.8)",
  mariadb: "sqlx MariaDB (ver. 0.8)",
  sqlite: "sqlx SQLite (ver. 0.8)",
  oracle: "Oracle thin driver (oracledb)",
};

/** `["DBMS: PostgreSQL (ver. 16.15 (Debian ...))", "Case sensitivity: ...", "Driver: ..."]`. */
function infoLines(t: TestInfo): string[] {
  const out: string[] = [];
  if (t.version) {
    const m = /^(PostgreSQL|MySQL|MariaDB|SQLite|Oracle)\s+(.*)$/s.exec(t.version);
    out.push(`DBMS: ${m ? m[1] : DBMS[t.dbms].label}${m ? ` (ver. ${m[2]})` : ""}`);
  } else {
    out.push(`DBMS: ${DBMS[t.dbms].label}`);
  }
  out.push(`Case sensitivity: ${CASE[t.dbms]}`);
  out.push(`Driver: ${DRIVER_LINE[t.dbms]}`);
  return out;
}

function sslLine(t: TestInfo): string | null {
  if (t.dbms === "sqlite") return null;
  if (t.ssl != null) return t.ssl ? "SSL: yes" : "SSL: no";
  if (!t.sslmode) return null;
  if (/^(disable|disabled)$/.test(t.sslmode)) return "SSL: no";
  if (/^(require|required|verify)/.test(t.sslmode)) return "SSL: yes";
  return null;
}

export function resultText(t: TestInfo, previous?: TestInfo): string {
  const head = t.ok ? "Succeeded" : "Failed";
  const lines = infoLines(t.ok ? t : (previous ?? t));
  const tail = t.ok ? ["", `Ping: ${t.elapsedMs} ms`, sslLine(t)].filter((x): x is string => x !== null) : ["", t.message];
  return [head, ...lines, ...tail].join("\n");
}

async function copyText(text: string) {
  try {
    if (isTauri()) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** Bottom bar of the right pane: "Test Connection" link, result icon, driver / version text and the result balloon. */
export function TestBar(props: { s: Session; /** The dialog tab shown: a switch closes the balloon. */ tab?: string }) {
  const s = props.s;
  const d = () => s.current()!;
  const t = () => d().test;
  const [open, setOpen] = createSignal(false);
  let link!: HTMLButtonElement;

  const run = async () => {
    setOpen(false);
    await s.test();
    setOpen(true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    }
  };
  window.addEventListener("keydown", onKey, true);
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  // the result describes the settings it was run with: an edit, another tab / data source or a click elsewhere closes it
  createEffect(
    on(
      () => [props.tab, s.selectedKey(), JSON.stringify(d().form), d().password.value] as const,
      () => setOpen(false),
      { defer: true },
    ),
  );
  const onDown = (e: MouseEvent) => {
    if (open() && !(e.target as Element | null)?.closest?.(".ds-balloon, .ds-test-status, .ds-testbar a, .ds-testbar button")) setOpen(false);
  };
  document.addEventListener("mousedown", onDown, true);
  onCleanup(() => document.removeEventListener("mousedown", onDown, true));

  const status = () => {
    const x = t().info ?? t().lastOk;
    return shortVersion(x?.ok ? x.version : (t().lastOk?.version ?? null), d().form.dbms);
  };

  return (
    <div class="ds-testbar">
      <LinkButton ref={link} onClick={() => void run()} disabled={t().state === "running"}>
        Test Connection
      </LinkButton>
      <span class="ds-test-status" onClick={() => t().state === "done" && setOpen(!open())}>
        <Show when={t().state === "running"}>
          <span class="ds-spinner" />
        </Show>
        <Show when={t().state === "done" && t().info}>
          <Icon name={t().info!.ok ? "green-checkmark" : "error"} class="ds-test-icon" />
        </Show>
        <Show when={t().state !== "done" && t().state !== "running"}>
          <span class="ds-test-icon-gap" />
        </Show>
        <span class="ds-test-text">{t().state === "running" ? "In progress…" : status()}</span>
      </span>

      <Show when={open() && t().state === "done" && t().info}>
        <div class="ds-balloon" role="status">
          <div class="ds-balloon-head">
            <span class={t().info!.ok ? "ds-ok" : "ds-fail"}>{t().info!.ok ? "Succeeded" : "Failed"}</span>
            <span class="ds-balloon-links">
              <LinkButton onClick={() => void copyText(resultText(t().info!, t().lastOk))}>Copy</LinkButton>
            </span>
          </div>
          <div class="ds-balloon-body" classList={{ "ds-dim": !t().info!.ok }}>
            <Show when={t().info!.ok || t().lastOk}>
              {infoLines(t().info!.ok ? t().info! : t().lastOk!).map((l) => (
                <div>{l}</div>
              ))}
            </Show>
          </div>
          <Show
            when={t().info!.ok}
            fallback={
              <div class="ds-balloon-body ds-balloon-msg" classList={{ "ds-balloon-gap": !!t().lastOk }}>
                {t().info!.message}
              </div>
            }
          >
            <div class="ds-balloon-body ds-balloon-gap">
              <div>Ping: {t().info!.elapsedMs} ms</div>
              <Show when={sslLine(t().info!)}>
                <div>{sslLine(t().info!)}</div>
              </Show>
            </div>
          </Show>
          <span class="ds-balloon-arrow" />
        </div>
      </Show>
    </div>
  );
}
