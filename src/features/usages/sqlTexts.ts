/**
 * The SQL texts Find Usages searches: open consoles (their editor holds the newest text), saved consoles that are not
 * open, opened `.sql` files (their documents hold the text as edited) and scratch files that are not open.
 * A text that cannot be read is left out: one deleted file is no reason to fail the search.
 */
import { type FileInfo, listConsoles, listScratches, readConsole, readFile } from "../../api/db";
import { allSessions } from "../console/registry";
import { explorerDataSources } from "../explorer";
import { docOf, openPaths } from "../files/docs";
import type { SqlText } from "./model";

export async function gatherSqlTexts(): Promise<SqlText[]> {
  const out: SqlText[] = [];
  const seen = new Set<string>();

  for (const s of allSessions()) {
    const view = s.editor?.view;
    if (!view) continue;
    out.push({ name: s.consoleName, text: view.state.doc.toString(), console: true, dsId: s.ds.id });
    seen.add(`console:${s.ds.id}:${s.consoleName}`);
  }
  const saved = await Promise.all(
    explorerDataSources().map(async (ds) => {
      const names = await listConsoles(ds.id).catch(() => [] as string[]);
      const texts = await Promise.all(
        names
          .filter((name) => !seen.has(`console:${ds.id}:${name}`))
          .map(async (name): Promise<SqlText | null> => {
            const text = await readConsole(ds.id, name).catch(() => null);
            return text === null ? null : { name, text, console: true, dsId: ds.id };
          }),
      );
      return texts.filter((t): t is SqlText => t !== null);
    }),
  );
  out.push(...saved.flat());

  for (const path of openPaths()) {
    const doc = docOf(path);
    if (!doc) continue;
    seen.add(`file:${path}`);
    out.push({ name: doc.name, text: doc.text, console: false, path, scratch: doc.scratch });
  }
  const scratches: FileInfo[] = await listScratches().catch(() => []);
  const files = await Promise.all(
    scratches
      .filter((f) => !seen.has(`file:${f.path}`))
      .map(async (f): Promise<SqlText | null> => {
        const content = await readFile(f.path).catch(() => null);
        return content === null ? null : { name: f.name, text: content.text, console: false, path: f.path, scratch: true };
      }),
  );
  out.push(...files.filter((t): t is SqlText => t !== null));
  return out;
}
