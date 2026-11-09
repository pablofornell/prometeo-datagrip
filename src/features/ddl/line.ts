/**
 * Where a usage's line is in a generated DDL (Find Usages opens the DDL of the routine, trigger or package that names
 * the searched object). The DDL is formatted by the DBMS (Oracle's `DBMS_METADATA` pretty-prints, PostgreSQL adds
 * its header), so the line number of the stored text is only a hint: the line is looked for by its text.
 */

/**
 * The 1-based line of `text` that holds `hint` (the usage's line text, trimmed; a clipped hint ends with "…" and matches
 * by its start). Among several matches the one nearest to `near` (the line the usage names) wins. With no match,
 * `near` itself, kept inside the text.
 */
export function ddlLineOf(text: string, hint: string | undefined, near: number): number {
  const lines = text.split("\n");
  const clamp = (n: number) => Math.min(Math.max(1, n), lines.length);
  const clipped = !!hint?.endsWith("…");
  const want = (hint ?? "").trim().replace(/…$/, "").trim();
  if (!want) return clamp(near);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (clipped ? !t.startsWith(want) : t !== want) return;
    const d = Math.abs(i + 1 - near);
    if (d < bestDistance) {
      best = i + 1;
      bestDistance = d;
    }
  });
  return best || clamp(near);
}
