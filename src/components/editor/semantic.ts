import { HARD_KEYWORDS, KEYWORD_FUNCTIONS, TABLE_INTRO, TYPE_NAMES, keywordsFor } from "./keywords";
import type { Token } from "./lexer";
import type { SchemaIndex, TableIdx } from "./schemaIndex";
import type { Dialect } from "./split";

export type MarkCls = "kw" | "str" | "num" | "cmt" | "fn" | "col" | "bad" | "param";

export interface Mark {
  from: number;
  to: number;
  cls: MarkCls;
}

export interface TableRef {
  /** Lower-case unquoted name parts as written: `[schema, table]` or `[table]`. */
  parts: string[];
  /** Lower-case alias, if any. */
  alias?: string;
  /** Alias as written (case preserved). */
  aliasText?: string;
  /** Resolved table in the schema snapshot (undefined: unknown, CTE or derived table). */
  table?: TableIdx;
  /** Derived table / CTE / table function: columns unknown. */
  opaque: boolean;
}

export interface Scope {
  refs: TableRef[];
  ctes: Set<string>;
  byName: Map<string, TableRef>;
  /** True if every reference resolved to a real table. */
  allResolved: boolean;
}

export interface Analysis {
  marks: Mark[];
  scope: Scope;
}

const keywordSets = new Map<Dialect, Set<string>>();
function kwSet(d: Dialect): Set<string> {
  let s = keywordSets.get(d);
  if (!s) keywordSets.set(d, (s = keywordsFor(d)));
  return s;
}

/** Lower-case unquoted text of an identifier token. */
export function identName(text: string): string {
  const c = text[0];
  if (c === '"' || c === "`") return text.slice(1, text.endsWith(c) && text.length > 1 ? -1 : undefined).replace(new RegExp(c + c, "g"), c).toLowerCase();
  if (c === "[") return text.slice(1, text.endsWith("]") ? -1 : undefined).toLowerCase();
  return text.toLowerCase();
}

type Role = "tbl" | "sch" | "alias" | "decl" | "collist";

/**
 * Semantic pass over the tokens of ONE statement. `text` is the full document text, `toks` the
 * statement's tokens (document offsets, comments included).
 */
export function analyzeStatement(text: string, toks: Token[], idx: SchemaIndex, dialect: Dialect, implicit?: TableRef[]): Analysis {
  const marks: Mark[] = [];
  const kws = kwSet(dialect);
  const sig: Token[] = [];
  for (const t of toks) {
    if (t.kind === "comment") marks.push({ from: t.from, to: t.to, cls: "cmt" });
    else sig.push(t);
  }
  const n = sig.length;
  const raw = sig.map((t) => text.slice(t.from, t.to));
  // lower-case word, or unquoted identifier name
  const lw = sig.map((t, i) => (t.kind === "word" ? raw[i].toLowerCase() : t.kind === "qident" ? identName(raw[i]) : raw[i]));
  const isWordAt = (i: number): boolean => i >= 0 && i < n && sig[i].kind === "word";
  const isNameAt = (i: number): boolean => i >= 0 && i < n && (sig[i].kind === "qident" || (sig[i].kind === "word" && !HARD_KEYWORDS.has(lw[i])));
  const isP = (i: number, p: string): boolean => i >= 0 && i < n && sig[i].kind === "punct" && raw[i] === p;
  /** A `.` joining token k-1 and k+1 without whitespace (qualified name), as opposed to a dangling `a. FROM`. */
  const joinDot = (k: number): boolean => isP(k, ".") && k > 0 && k + 1 < n && sig[k - 1].to === sig[k].from && sig[k].to === sig[k + 1].from;
  const firstTokDot = (k: number): boolean => isP(k, ".") && k > 0 && sig[k - 1].to === sig[k].from; // dot glued to the left token
  const first = isWordAt(0) ? lw[0] : "";
  const roles: (Role | undefined)[] = new Array(n);
  const owners: (string | undefined)[] = new Array(n); // lower-case word before the innermost open paren
  const match: number[] = new Array(n).fill(-1); // paren matching

  // ---- paren structure
  {
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      owners[i] = stack.length ? (isWordAt(stack[stack.length - 1] - 1) ? lw[stack[stack.length - 1] - 1] : "") : undefined;
      if (isP(i, "(")) stack.push(i);
      else if (isP(i, ")") && stack.length) {
        const o = stack.pop() as number;
        match[o] = i;
        match[i] = o;
      }
    }
  }

  // ---- pass 1: table references, CTE names
  const refs: TableRef[] = implicit ? [...implicit] : [];
  const ctes = new Set<string>();
  const colLists = new Map<number, TableRef>();
  const tokRef = new Map<number, TableRef>();

  const parseName = (j: number): { parts: string[]; idxs: number[]; end: number } | null => {
    if (!isNameAt(j)) return null;
    const parts = [lw[j]];
    const idxs = [j];
    let k = j + 1;
    while (joinDot(k) && isNameAt(k + 1) && parts.length < 3) {
      parts.push(lw[k + 1]);
      idxs.push(k + 1);
      k += 2;
    }
    return { parts, idxs, end: k };
  };

  const parseTableList = (start: number, multi: boolean, introWord: string): void => {
    let j = start;
    for (;;) {
      // optional noise words
      while (isWordAt(j) && ["only", "lateral", "table"].includes(lw[j]) && introWord !== "table") j++;
      if (isWordAt(j) && lw[j] === "if" && isWordAt(j + 1) && lw[j + 1] === "exists") j += 2;
      if (isP(j, "(")) {
        // derived table: columns unknown
        const k = match[j] >= 0 ? match[j] : n - 1;
        let a = k + 1;
        if (isWordAt(a) && lw[a] === "as") a++;
        const ref: TableRef = { parts: [], opaque: true };
        if (isNameAt(a)) {
          ref.alias = lw[a];
          ref.aliasText = raw[a];
          roles[a] = "alias";
          a++;
        }
        refs.push(ref);
        j = a;
      } else {
        const nm = parseName(j);
        if (!nm) return;
        const end = nm.end;
        if (firstTokDot(end) && !joinDot(end)) {
          // `FROM sales.|` being typed: the name is a qualifier, not a table
          for (const q of nm.idxs) roles[q] = "sch";
          return;
        }
        if (isP(end, "(") && (introWord === "from" || introWord === "join")) {
          // table function: generate_series(..) AS t(a, b)
          const k = match[end] >= 0 ? match[end] : n - 1;
          let a = k + 1;
          if (isWordAt(a) && lw[a] === "as") a++;
          const ref: TableRef = { parts: nm.parts, opaque: true };
          if (isNameAt(a)) {
            ref.alias = lw[a];
            ref.aliasText = raw[a];
            roles[a] = "alias";
            a++;
          }
          refs.push(ref);
          j = a;
        } else {
          const ref: TableRef = { parts: nm.parts, opaque: false, table: idx.findTable(nm.parts) };
          for (let q = 0; q < nm.idxs.length; q++) {
            roles[nm.idxs[q]] = q === nm.idxs.length - 1 ? "tbl" : "sch";
            tokRef.set(nm.idxs[q], ref);
          }
          let a = end;
          if (isWordAt(a) && lw[a] === "as") a++;
          if (isNameAt(a) && !roles[a] && !(isWordAt(a) && kws.has(lw[a]))) {
            ref.alias = lw[a];
            ref.aliasText = raw[a];
            roles[a] = "alias";
            a++;
          }
          refs.push(ref);
          if (isP(a, "(") && (introWord === "into" || introWord === "references" || introWord === "on")) {
            const k = match[a];
            if (k > a) for (let q = a + 1; q < k; q++) colLists.set(q, ref);
          }
          j = a;
        }
      }
      if (multi && isP(j, ",")) {
        j++;
        continue;
      }
      return;
    }
  };

  const createsIndex = first === "create" && sig.slice(0, 6).some((_, q) => isWordAt(q) && lw[q] === "index");
  for (let i = 0; i < n; i++) {
    if (!isWordAt(i) || joinDot(i - 1)) continue;
    const w = lw[i];
    const prev = isWordAt(i - 1) ? lw[i - 1] : "";
    switch (w) {
      case "from":
        if (prev === "distinct" || ["extract", "substring", "trim", "overlay"].includes(owners[i] ?? "")) break;
        parseTableList(i + 1, true, "from");
        break;
      case "join":
        parseTableList(i + 1, false, "join");
        break;
      case "update":
        if (i === 0 || isP(i - 1, ")")) parseTableList(i + 1, first === "update", "update");
        break;
      case "into":
        if (["insert", "replace", "merge"].includes(first)) parseTableList(i + 1, false, "into");
        break;
      case "truncate":
        if (i === 0) parseTableList(i + 1, true, "truncate");
        break;
      case "table":
        if (["drop", "alter", "truncate", "lock", "analyze", "vacuum"].includes(prev)) parseTableList(i + 1, first !== "alter", "table");
        else if (first === "create") markDecl(i + 1);
        break;
      case "view":
        if (prev === "drop" || prev === "alter") parseTableList(i + 1, true, "view");
        else if (first === "create") markDecl(i + 1);
        break;
      case "references":
        parseTableList(i + 1, false, "references");
        break;
      case "on":
        if (createsIndex && !refs.some((r) => r.parts.length) && !isP(i - 1, ")")) parseTableList(i + 1, false, "on");
        break;
      case "index":
      case "trigger":
      case "function":
      case "procedure":
      case "sequence":
      case "schema":
      case "database":
        if (first === "create" || first === "alter" || first === "drop") markDecl(i + 1);
        break;
      default:
        break;
    }
    // CTE: name AS ( ... )   preceded by WITH [RECURSIVE] or ','
    if (isNameAt(i) && isWordAt(i + 1) && lw[i + 1] === "as" && (isP(i + 2, "(") || (isWordAt(i + 2) && ["materialized", "not"].includes(lw[i + 2])))) {
      if (i === 0 ? false : lw[i - 1] === "with" || lw[i - 1] === "recursive" || isP(i - 1, ",")) {
        ctes.add(lw[i]);
        roles[i] = "decl";
      }
    }
  }
  function markDecl(j: number): void {
    // skip IF NOT EXISTS / OR REPLACE noise, then the (possibly qualified) name is a declaration
    while (isWordAt(j) && ["if", "not", "exists", "concurrently", "unique"].includes(lw[j])) j++;
    while (isNameAt(j)) {
      roles[j] = "decl";
      if (joinDot(j + 1)) j += 2;
      else break;
    }
  }

  // ---- scope
  const byName = new Map<string, TableRef>();
  for (const r of refs) {
    if (r.alias) byName.set(r.alias, r);
    if (r.parts.length) {
      const last = r.parts[r.parts.length - 1];
      if (!byName.has(last)) byName.set(last, r);
    }
  }
  const scope: Scope = { refs, ctes, byName, allResolved: refs.length > 0 && refs.every((r) => !r.opaque && !!r.table) };
  const flagUnresolved = !idx.empty;
  const resolvedRefs = refs.filter((r) => r.table);
  const anyOpaque = refs.some((r) => r.opaque) || ctes.size > 0;
  const ddl = first === "create" || first === "alter";

  const scopeColumn = (name: string): boolean => resolvedRefs.some((r) => r.table?.byName.has(name));

  // function call detection: ident followed by "(" and not in a table-introducing position
  const isCall = (i: number): boolean => {
    if (!isP(i + 1, "(") || roles[i]) return false;
    let b = i - 1;
    while (joinDot(b) && isNameAt(b - 1)) b -= 2;
    return !(isWordAt(b) && (TABLE_INTRO.has(lw[b]) || ["function", "procedure", "type", "as", "returns"].includes(lw[b])));
  };

  // ---- pass 2: classification
  for (let i = 0; i < n; i++) {
    const t = sig[i];
    const mk = (cls: MarkCls): void => {
      marks.push({ from: t.from, to: t.to, cls });
    };
    switch (t.kind) {
      case "string":
        mk("str");
        continue;
      case "number":
        mk("num");
        continue;
      case "param":
        mk("param");
        continue;
      case "punct":
        continue;
      default:
        break;
    }
    const w = lw[i];
    const afterDot = joinDot(i - 1);
    const beforeDot = joinDot(i + 1) && isNameAt(i + 2);
    const role = roles[i];

    if (t.kind === "word" && !afterDot && !role) {
      // keywords, types and calls first for unqualified words
      if (HARD_KEYWORDS.has(w)) {
        mk("kw");
        continue;
      }
    }

    if (role === "decl" || role === "alias") continue;
    if (role === "tbl" || role === "sch") {
      if (flagUnresolved) {
        if (role === "tbl") {
          const owner = tokRef.get(i);
          if (owner && !owner.table && !(ctes.has(w) && owner.parts.length === 1)) mk("bad");
        } else if (!idx.hasSchema(w) && !ctes.has(w)) {
          mk("bad");
        }
      }
      continue;
    }
    if (role === "collist") continue;
    const lref = colLists.get(i);
    if (lref) {
      if (lref.table) mk(lref.table.byName.has(w) ? "col" : "bad");
      continue;
    }

    if (afterDot) {
      // qualified: x.y or x.y.z
      if (isCall(i)) {
        mk("fn");
        continue;
      }
      // qualifier = token before the dot; owner table
      const q = i - 2;
      if (!isNameAt(q)) continue;
      const qn = lw[q];
      let tbl: TableIdx | undefined;
      let opaque = false;
      if (joinDot(q - 1) && isNameAt(q - 2)) {
        tbl = idx.findTable([lw[q - 2], qn]); // schema.table.col
      } else {
        const r = byName.get(qn);
        if (r) {
          tbl = r.table;
          opaque = r.opaque;
        } else if (ctes.has(qn)) opaque = true;
        else if (idx.hasSchema(qn)) continue; // schema.table in an expression position: nothing to color
      }
      if (tbl) {
        if (tbl.byName.has(w)) mk("col");
        else if (flagUnresolved && !opaque) mk("bad");
      }
      continue;
    }

    if (beforeDot) {
      // qualifier: alias, table or schema. Plain, red when it names nothing.
      if (flagUnresolved && !role && refs.length > 0 && !anyOpaque && !byName.has(w) && !idx.hasSchema(w) && !ctes.has(w) && ["select", "with", "update", "delete", "insert"].includes(first)) mk("bad");
      continue;
    }

    // unqualified word / quoted identifier
    if (t.kind === "qident") {
      if (resolvedRefs.length && scopeColumn(w)) mk("col");
      continue;
    }
    if (TYPE_NAMES.has(w)) {
      const prevTok = i > 0 ? sig[i - 1] : undefined;
      const afterCast = prevTok?.kind === "punct" && raw[i - 1] === "::";
      const asType = isWordAt(i - 1) && lw[i - 1] === "as" && (isP(i + 1, ")") || isP(i + 1, "("));
      const ddlType = ddl && prevTok !== undefined && (prevTok.kind === "word" || prevTok.kind === "qident") && !HARD_KEYWORDS.has(lw[i - 1]);
      const typed = isP(i + 1, "(") && (ddl || afterCast);
      const returns = isWordAt(i - 1) && lw[i - 1] === "returns";
      if (afterCast || asType || ddlType || typed || returns) {
        mk("kw");
        continue;
      }
    }
    if (isCall(i) && !(kws.has(w) && !KEYWORD_FUNCTIONS.has(w))) {
      mk("fn");
      continue;
    }
    if (scopeColumn(w) && !isP(i + 1, "(")) {
      mk("col");
      continue;
    }
    if (kws.has(w)) {
      mk("kw");
      continue;
    }
  }
  marks.sort((a, b) => a.from - b.from);
  return { marks, scope };
}
