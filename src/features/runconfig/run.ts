/**
 * Runs a "Database Script" configuration: for every target data source a dedicated session runs the script text or
 * each script file in order, and the log goes to a tab of the Run tool window (same wording as the Database Output).
 */
import { type Accessor, createSignal } from "solid-js";
import { type ExecHandle, closeSession, execute, openSession, readFile } from "../../api/db";
import { splitStatements } from "../../components/editor";
import { notify } from "../../components/ui";
import { showToolWindow } from "../../state/layout";
import { dsOf } from "../console/ds";
import { ensureConnected } from "../explorer";
import { completedIn, rowsAffected, rowsRetrieved, summary } from "../output/format";
import { ConsoleOutput } from "../output/model";
import { type RunConfig, initSql } from "./model";

const errText = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error:\s*/, "");

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

/** Starts the configuration. A configuration without "Allow multiple instances" replaces its own earlier run. */
export function startRun(cfg: RunConfig): RunSession {
  if (!cfg.allowMultiple) for (const r of runs().filter((x) => x.cfgId === cfg.id)) closeRun(r.id);
  const first = dsOf(cfg.targets[0]?.dsId ?? "");
  const out = new ConsoleOutput(`run:${cfg.id}:${++seq}`, first?.driver ?? "postgres");
  const [running, setRunning] = createSignal(true);
  let cancelled = false;
  let handle: ExecHandle | undefined;
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
    try {
      for (const target of cfg.targets) {
        const ds = dsOf(target.dsId);
        if (!ds) {
          out.log("error", "The data source of this configuration no longer exists");
          failed++;
          continue;
        }
        if (cancelled) break;
        out.log("text", `Connecting to ${ds.name}…`);
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
          const scripts = cfg.mode === "text" ? [{ label: cfg.name, text: cfg.text }] : [];
          if (cfg.mode === "files") {
            for (const p of cfg.files) {
              try {
                scripts.push({ label: p, text: (await readFile(p)).text });
              } catch (e) {
                out.log("error", `Cannot read ${p}: ${errText(e)}`);
                failed++;
              }
            }
          }
          for (const s of scripts) {
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
          }
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
      out.log("text", summary(executed, total, failed, ms, symbols, cancelled));
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
