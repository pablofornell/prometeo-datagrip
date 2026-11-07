/**
 * Run configurations ("Database Script"): the Run/Debug Configurations dialog, running a `.sql` file or a list of
 * script files against chosen data sources, and the Run tool window with the log.
 * Actions: run.editConfigurations, run.file (Ctrl+Shift+F10 in a file), run.chooseConfiguration, run.sqlScript.
 */
import { chooseOpenFiles } from "../../api/db";
import { notify } from "../../components/ui";
import { openMenu } from "../../components/ui";
import { registerActions } from "../../state/actions";
import { registerSlot } from "../../state/slots";
import { activeTab } from "../../state/tabs";
import { dsOf } from "../console/ds";
import { explorerDataSources } from "../explorer";
import { fileTabData, fileTarget } from "../files";
import { baseName, newConfig, uniqueName, validate } from "./model";
import { openConfigurationsDialog, openRunDialog } from "./RunConfigDialog";
import { RunBody, RunHeader } from "./RunWindow";
import { startRun } from "./run";
import { configOfFile, configs, saveConfig } from "./store";
import "./runconfig.css";

const knownDs = (): Set<string> => new Set(explorerDataSources().map((d) => d.id));

/** Path of the file in the active editor tab. */
const activeFilePath = (): string | undefined => {
  const t = activeTab();
  return t?.kind === "file" ? fileTabData(t)?.path : undefined;
};

/**
 * Run '<file>' (Ctrl+Shift+F10): the file's own configuration when it has a valid one, else a temporary one against
 * the data source chosen in the editor, else the configuration dialog asks for the target.
 */
export function runFile(path: string): void {
  const existing = configOfFile(path);
  if (existing && !validate(existing, knownDs())) return void startRun(existing);
  const dsId = fileTarget(path);
  const cfg =
    existing ??
    newConfig({
      name: uniqueName(baseName(path), configs().map((c) => c.name)),
      files: [path],
      temporary: true,
      targets: dsId && dsOf(dsId) ? [{ dsId }] : [],
    });
  if (!validate(cfg, knownDs())) {
    saveConfig(cfg);
    return void startRun(cfg);
  }
  openRunDialog(cfg);
}

/** Explorer > SQL Scripts > Run SQL Script…: pick .sql files, then the configuration dialog opens for them. */
export async function runSqlScripts(dsId?: string, schema?: string): Promise<void> {
  try {
    const files = await chooseOpenFiles();
    if (!files.length) return;
    openRunDialog(
      newConfig({
        name: uniqueName(files.length === 1 ? files[0].name : "Database Script", configs().map((c) => c.name)),
        files: files.map((f) => f.path),
        targets: dsId && dsOf(dsId) ? [{ dsId, schema }] : [],
      }),
    );
  } catch (e) {
    notify({ kind: "error", title: "Cannot open the file", body: String((e as Error)?.message ?? e) });
  }
}

registerActions([
  { id: "run.editConfigurations", title: "Edit Configurations…", run: () => openConfigurationsDialog() },
  {
    id: "run.file",
    title: "Run File",
    shortcut: "Ctrl+Shift+F10",
    icon: "run",
    // in a file the key runs it; elsewhere Ctrl+Shift+F10 stays "Jump to Query Console"
    when: () => !!activeFilePath(),
    run: (ctx) => {
      const path = (ctx as { path?: string } | undefined)?.path ?? activeFilePath();
      if (path) runFile(path);
    },
  },
  {
    id: "run.chooseConfiguration",
    title: "Run…",
    shortcut: "Alt+Shift+F10",
    run: () => {
      const list = configs().filter((c) => !c.temporary || !validate(c, knownDs()));
      openMenu(
        [
          ...list.map((c) => ({ label: `Run '${c.name}'`, icon: "run", run: () => (validate(c, knownDs()) ? openConfigurationsDialog(c.id) : startRun(c)) })),
          ...(list.length ? [{ type: "separator" as const }] : []),
          { label: "Edit Configurations…", run: () => openConfigurationsDialog() },
        ],
        { center: true, title: "Run", compact: true, minWidth: 320 },
      );
    },
  },
  { id: "run.sqlScript", title: "Run SQL Script…", icon: "run", run: (ctx) => void runSqlScripts((ctx as { dsId?: string } | undefined)?.dsId, (ctx as { schema?: string } | undefined)?.schema) },
]);

registerSlot("run.header", RunHeader);
registerSlot("run.body", RunBody);

