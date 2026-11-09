/**
 * Runs a "Database Script" configuration. A script text runs on a session of each target data source, statement by
 * statement. A script file runs on the backend (`run_sql_file`): it is read in pieces, so its size does not matter, it
 * shows a status task with Cancel, and a balloon tells the outcome. The log goes to a tab of the Run tool window (same
 * wording as the Database Output).
 */
import { type Accessor, createSignal } from "solid-js";
import { type ExecHandle, closeSession, execute, openSession } from "../../api/db";
import { cancelScript, runSqlFile } from "../../api/tauri";
import { splitStatements } from "../../components/editor";
import { notify } from "../../components/ui";
import { showToolWindow } from "../../state/layout";
import { startTask } from "../../state/status";
import { dsOf } from "../console/ds";
import { ensureConnected } from "../explorer";
import { completedIn, formatDuration, rowsAffected, rowsRetrieved, summary } from "../output/format";
import { ConsoleOutput } from "../output/model";
import { type RunConfig, baseName, initSql, scriptOptionsOf, scriptResult, stopsAfterFailure } from "./model";

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/** Summary line of a file run (its statements are not counted up front, so there is no "of N"). */
const fileSummary = (ok: number, failed: number, ms: number, aborted: boolean): string =>
  `Summary: ${ok} statements ran${failed ? `, ${failed} failed` : ""} in ${formatDuration(ms)}${aborted ? " (aborted!)" : ""}`;

export interface RunSession {
  id: string;
  cfgId: string;
  title: string;
  out: ConsoleOutput;
  /** A snapshot of the configuration that was started (a rerun uses the edited one when it still exists). */
  cfg: RunConfig;
  readonly running: Accessor<boolean>;
  stop(): void;
}

const [runs, setRuns] = createSignal<RunSession[]>([]);
const [activeRunId, setActiveRunId] = createSignal<string | null>(null);
export { runs, activeRunId };
export const setActiveRun = (id: string | null): void => void setActiveRunId(id);
export const activeRun = (): RunSession | undefined => runs().find((r) => r.id === activeRunId());

export function closeRun(id: string): void {
  const r = runs().find((x) => x.id === id);
  if (!r) return;
  r.stop();
  r.out.dispose();
  const rest = runs().filter((x) => x.id !== id);
  setRuns(rest);
  if (activeRunId() === id) setActiveRunId(rest[rest.length - 1]?.id ?? null);
}

let seq = 0;

/** Runs one script file of a target on the backend. `id` is the cancel id of the run. */
async function runFile(
  out: ConsoleOutput,
  ds: { id: string; name: string },
  schema: string | undefined,
  path: string,
  cfg: RunConfig,
  id: string,
): Promise<{ ok: number; failed: number; cancelled: boolean }> {
  const name = baseName(path);
  const task = startTask(`Running ${name} on ${ds.name}…`, { cancel: () => void cancelScript(id).catch(() => {}) });
  try {
    const sum = await runSqlFile(ds.id, id, schema, path, scriptOptionsOf(cfg), (p) =>
      task.progress(p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : undefined),
    );
    const r = scriptResult(sum, name, cfg.stopOnError);
    out.log(sum.failed ? "error" : "text", r.body);
    notify({ kind: r.kind, title: r.title, body: r.body, timeout: r.kind === "success" ? 6000 : 0 });
    return { ok: sum.ok, failed: sum.failed, cancelled: sum.cancelled };
  } catch (e) {
    out.log("error", errText(e));
    notify({ kind: "error", title: `${name} failed`, body: errText(e) });
    return { ok: 0, failed: 1, cancelled: false };
  } finally {
    task.done();
  }
}

/** Starts the configuration. A configuration without "Allow multiple instances" replaces its own earlier run. */
export function startRun(cfg: RunConfig): RunSession {
  if (!cfg.allowMultiple) for (const r of runs().filter((x) => x.cfgId === cfg.id)) closeRun(r.id);
  const first = dsOf(cfg.targets[0]?.dsId ?? "");
  const out = new ConsoleOutput(`run:${cfg.id}:${++seq}`, first?.driver ?? "postgres");
  const [running, setRunning] = createSignal(true);
  let cancelled = false;
  let handle: ExecHandle | undefined;
  /** The script file being run on the backend (its cancel id). */
  let scriptId: string | undefined;
  const session: RunSession = {
    id: out.tabId,
    cfgId: cfg.id,
    title: cfg.name,
    out,
    cfg: structuredClone(cfg),
    running,
    stop: () => {
      cancelled = true;
      void handle?.cancel().catch(() => {});
      if (scriptId) void cancelScript(scriptId).catch(() => {});
    },
  };
  setRuns([...runs(), session]);
  setActiveRunId(session.id);
  if (cfg.activateTool) showToolWindow("run", cfg.focusTool);
  out.setRunning(true);

  void (async () => {
    const t0 = performance.now();
    let executed = 0;
    let failed = 0;
    let total = 0;
    let symbols = 0;
    /** A file failed and the configuration stops at errors: nothing else is started. */
    let halted = false;
    try {
      for (const target of cfg.targets) {
        const ds = dsOf(target.dsId);
        if (!ds) {
          out.log("error", "The data source of this configuration no longer exists");
          failed++;
          continue;
        }
        if (cancelled || halted) break;
        out.log("text", `Connecting to ${ds.name}…`);
        if (cfg.mode === "files") {
          try {
            await ensureConnected(ds.id);
          } catch (e) {
            out.log("error", errText(e));
            failed++;
            halted = stopsAfterFailure(cfg, 1);
            continue;
          }
          for (const p of cfg.files) {
            if (cancelled || halted) break;
            out.log("text", `Run ${p}`);
            scriptId = newId();
            const r = await runFile(out, ds, target.schema, p, cfg, scriptId);
            scriptId = undefined;
            executed += r.ok;
            failed += r.failed;
            if (r.cancelled) cancelled = true;
            if (stopsAfterFailure(cfg, r.failed)) halted = true;
          }
          continue;
        }
        let sid: string;
        try {
          await ensureConnected(ds.id);
          sid = await openSession(ds.id, initSql(ds.driver, target.schema));
        } catch (e) {
          out.log("error", errText(e));
          failed++;
          continue;
        }
        const prompt = target.schema ? `${ds.database || ds.name}.${target.schema}` : ds.name;
        try {
          const s = { label: cfg.name, text: cfg.text };
          if (cancelled) break;
          out.log("text", `Run ${s.label}`);
          total += Math.max(1, splitStatements(s.text, ds.driver).length);
          symbols += s.text.length;
          let t = performance.now();
          const h = await execute(sid, s.text, {
            onStatement: (e) => {
              executed++;
              t = performance.now();
              out.log("sql", e.sql, prompt);
            },
            onResultSet: (e) => void out.log("text", rowsRetrieved(e.rows.length, performance.now() - t)),
            onUpdate: (e) => void out.log("text", /^\s*(insert|update|delete|merge|replace)\b/i.test(lastSql(out)) ? rowsAffected(e.rowsAffected, performance.now() - t) : completedIn(performance.now() - t)),
            onError: (e) => {
              failed++;
              out.log("error", e.message);
            },
            onMessage: (e) => void out.log("text", e.text),
          });
          handle = h;
          await h.done;
          handle = undefined;
        } finally {
          void closeSession(sid).catch(() => {});
        }
      }
    } catch (e) {
      out.log("error", errText(e));
      failed++;
      notify({ kind: "error", title: `${cfg.name} failed`, body: errText(e) });
    } finally {
      const ms = performance.now() - t0;
      out.log("text", cfg.mode === "files" ? fileSummary(executed, failed, ms, cancelled) : summary(executed, total, failed, ms, symbols, cancelled));
      out.setLastMs(ms);
      out.setRunning(false);
      setRunning(false);
    }
  })();
  return session;
}

/** The text of the statement the log echoed last. */
function lastSql(out: ConsoleOutput): string {
  for (let i = out.lines.length - 1; i >= 0; i--) if (out.lines[i].kind === "sql") return out.lines[i].text;
  return "";
}
