/** Dump to SQL File: opens the dialog for a target and reports how the dump ended in a balloon. */
import type { Driver } from "../../api/db";
import { openDumpFolder } from "../../api/tauri";
import { notify } from "../../components/ui";
import { ensureConnected } from "../explorer";
import { mountDialog } from "../table/dialogs";
import { dsInfo, errText, requireDriver } from "../table/ds";
import { DumpDialog, type DumpOutcome } from "./DumpDialog";
import { dumpResultText } from "./model";
import type { DumpTarget } from "./target";

/** The balloon of a dump that ended: finished (with "Open Folder"), cancelled (no file), or failed. */
export function reportDump(o: DumpOutcome): void {
  if (o.kind === "failed") {
    notify({ kind: "error", title: "Dump failed", body: o.message });
    return;
  }
  if (o.result.cancelled) {
    notify({ kind: "info", title: "Dump cancelled", body: "The file was removed.", timeout: 6000 });
    return;
  }
  notify({
    kind: "success",
    title: "Dump finished",
    body: `${dumpResultText(o.result)} written to ${o.path} (${(o.result.elapsedMs / 1000).toFixed(1)} s)`,
    actions: [
      {
        label: "Open Folder",
        run: () => void openDumpFolder(o.path).catch((e) => notify({ kind: "error", title: "Cannot open the folder", body: errText(e) })),
      },
    ],
    timeout: 15000,
  });
}

/** `dump.sqlFile`: the Dump to SQL File dialog for `t` (connects the data source first). */
export async function openDump(t: DumpTarget): Promise<void> {
  let driver: Driver;
  try {
    driver = await requireDriver(t.dsId);
    await ensureConnected(t.dsId);
  } catch (e) {
    notify({ kind: "error", title: "Cannot dump the data", body: errText(e) });
    return;
  }
  const ds = dsInfo(t.dsId);
  mountDialog((close) => (
    <DumpDialog
      target={{ ...t, driver }}
      dsName={ds?.name ?? t.dsId}
      onClose={close}
      onDone={(o) => {
        close();
        reportDump(o);
      }}
    />
  ));
}
