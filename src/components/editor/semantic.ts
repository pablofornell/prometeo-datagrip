import { HARD_KEYWORDS, KEYWORD_FUNCTIONS, TABLE_INTRO, TYPE_NAMES, keywordsFor } from "./keywords";
import type { Token } from "./lexer";
import type { SchemaIndex, TableIdx } from "./schemaIndex";
import type { Dialect } from "./split";
import type { SchemaColumn } from "./types";

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

/** A name that does not resolve: the message of the inspection ("Unable to resolve column 'x'"). */
export interface Unresolved {
  from: number;
  to: number;
  kind: "table" | "column" | "schema";
  message: string;
}

/** An identifier that resolved to a table or column of the schema snapshot (navigation, quick documentation). */
export interface Resolved {
  from: number;
  to: number;
  table: TableIdx;
  column?: SchemaColumn;
}

export interface Analysis {
  marks: Mark[];
  scope: Scope;
  unresolved: Unresolved[];
  resolved: Resolved[];
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

/**
 * Oracle objects every session sees that the schema snapshot leaves out (Oracle-maintained schemas are hidden):
 * the data dictionary and dynamic performance views (`ALL_*`, `USER_*`, `DBA_*`, `V$*`, `GV$*`) and `DUAL`, bare or
 * qualified with `SYS` / `SYSTEM` / `PUBLIC`, which are public synonyms of them.
 */
const ORACLE_DICTIONARY = /^((all|user|dba|cdb)_.+|g?v\$.+|dual|dictionary|dict|dict_columns|tab|cat|col|obj|seq|syn|ind)$/;
export function isOracleDictionaryName(parts: string[]): boolean {
  if (parts.length === 0 || parts.length > 2) return false;
  if (parts.length === 2 && !["sys", "system", "public"].includes(parts[0])) return false;
  return ORACLE_DICTIONARY.test(parts[parts.length - 1]);
}

type Role = "tbl" | "sch" | "alias" | "decl" | "collist";

/**
 * Semantic pass over the tokens of ONE statement. `text` is the full document text, `toks` the
 * statement's tokens (document offsets, comments included).
 */
export function analyzeStatement(text: string, toks: Token[], idx: SchemaIndex, dialect: Dialect, implicit?: TableRef[]): Analysis {
  const marks: Mark[] = [];
  const unresolved: Unresolved[] = [];
  const resolved: Resolved[] = [];
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
        if (nm.parts.length === 1 && nm.parts[0] === "dual" && introWord === "from" && !idx.findTable(nm.parts)) {
          // MySQL / Oracle `FROM dual`: a pseudo table without columns
          refs.push({ parts: nm.parts, opaque: true });
          j = end;
          if (multi && isP(j, ",")) {
            j++;
            continue;
          }
          return;
        }
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
          const table = idx.findTable(nm.parts);
          // Oracle: a synonym whose target is not in the snapshot, a dictionary view: real objects of unknown columns
          const known = !table && dialect === "oracle" && (!!idx.synonym(nm.parts) || isOracleDictionaryName(nm.parts));
          const ref: TableRef = { parts: nm.parts, opaque: known, table };
          for (let q = 0; q < nm.idxs.length; q++) {
            roles[nm.idxs[q]] = q === nm.idxs.length - 1 ? "tbl" : "sch";
            tokRef.set(nm.idxs[q], ref);
          }
          let a = end;
          if (isWordAt(a) && lw[a] === "as") a++;
          if (isNameAt(a) && !roles[a] && !(isWordAt(a) && (kws.has(lw[a]) || (lw[a] === "indexed" && isWordAt(a + 1) && lw[a + 1] === "by")))) {
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
      case "using":
        // PostgreSQL / MySQL `DELETE FROM t USING u`: u is a table (`JOIN .. USING (col)` and `CONVERT(a USING cs)` are not)
        if (first === "delete" && owners[i] === undefined && !isP(i + 1, "(")) parseTableList(i + 1, true, "using");
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
    // CTE: name [(col, ..)] AS ( ... )   preceded by WITH [RECURSIVE] or ','
    let ca = i + 1;
    if (isNameAt(i) && isP(ca, "(") && match[ca] > ca) ca = match[ca] + 1; // column list: `r(n) AS (..)`
    if (isNameAt(i) && isWordAt(ca) && lw[ca] === "as" && (isP(ca + 1, "(") || (isWordAt(ca + 1) && ["materialized", "not"].includes(lw[ca + 1])))) {
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

  // MySQL 8 row alias: `INSERT .. VALUES (..) AS nw [(x, y)] ON DUPLICATE KEY UPDATE a = nw.a`
  if ((first === "insert" || first === "replace") && refs.length) {
    for (let d = 1; d + 2 < n; d++) {
      if (!(owners[d] === undefined && lw[d] === "on" && isWordAt(d) && lw[d + 1] === "duplicate" && lw[d + 2] === "key")) continue;
      let a = d - 1;
      const listed = isP(a, ")") && match[a] >= 0 && isNameAt(match[a] - 1) && isWordAt(match[a] - 2) && lw[match[a] - 2] === "as";
      if (listed) a = match[a] - 1;
      if (isNameAt(a) && isWordAt(a - 1) && lw[a - 1] === "as") {
        roles[a] = "alias";
        const target = refs.find((r) => r.parts.length);
        refs.push({ parts: [], alias: lw[a], aliasText: raw[a], table: target?.table, opaque: listed || !target?.table });
      }
      break;
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
  const plain = (i: number): string => {
    const r = raw[i];
    const c = r[0];
    if (c === '"' || c === "`") return r.slice(1, r.endsWith(c) && r.length > 1 ? -1 : undefined).replace(new RegExp(c + c, "g"), c);
    return c === "[" ? r.slice(1, r.endsWith("]") ? -1 : undefined) : r;
  };
  const flag = (i: number, kind: Unresolved["kind"]): void => {
    unresolved.push({ from: sig[i].from, to: sig[i].to, kind, message: `Unable to resolve ${kind} '${plain(i)}'` });
  };
  const hit = (i: number, table: TableIdx, column?: string): void => {
    resolved.push({ from: sig[i].from, to: sig[i].to, table, column: column === undefined ? undefined : table.byName.get(column) });
  };
  // Unqualified columns are only judged in a plain query over real tables: no CTE, derived table or table function
  // (their columns are unknown), and not at positions where a word may be an alias, a type or a function keyword.
  const judgeBare = ["select", "update", "delete"].includes(first) && ctes.size === 0 && refs.length > 0 && refs.every((r) => !r.opaque && !!r.table);
  const aliasNames = new Set<string>();
  if (judgeBare) {
    for (let i = 1; i < n; i++) {
      if (sig[i].kind !== "word" && sig[i].kind !== "qident") continue;
      const pk = sig[i - 1].kind;
      if (isWordAt(i - 1) && lw[i - 1] === "as") aliasNames.add(lw[i]);
      else if (pk === "string" || pk === "number" || (pk === "qident" && !joinDot(i - 1)) || isP(i - 1, ")") || (isWordAt(i - 1) && !HARD_KEYWORDS.has(lw[i - 1]) && !kws.has(lw[i - 1]))) aliasNames.add(lw[i]);
    }
  }
  const BARE_PREV = new Set(["select", "where", "and", "or", "on", "by", "having", "set", "when", "then", "else", "not", "in", "like", "ilike", "between", "is", "case", "distinct", "returning", "using", "limit", "offset"]);
  const BARE_PUNCT = new Set([",", "(", "=", "<", ">", "+", "-", "*", "/", "%", "|", "&", "!"]);
  const NOT_COLUMNS = new Set(["current_date", "current_time", "current_timestamp", "localtime", "localtimestamp", "current_user", "session_user", "user", "current_schema", "current_catalog", "sysdate", "true", "false", "null", "unknown", "default", "excluded", "rowid", "_rowid_", "oid", "ctid", "xmin", "xmax", "cmin", "cmax", "tableoid", "all", "any", "some", "value", "utc_timestamp", "utc_date", "utc_time", "current_role", "systimestamp"]);
  const bareJudged = (i: number): boolean => {
    if (!judgeBare || !isNameAt(i) || NOT_COLUMNS.has(lw[i]) || aliasNames.has(lw[i]) || isP(i + 1, "(") || joinDot(i + 1)) return false;
    if (sig[i].kind === "word" && (kws.has(lw[i]) || TYPE_NAMES.has(lw[i]))) return false;
    if (["extract", "substring", "trim", "overlay", "position", "interval", "cast", "convert", "xmlelement"].includes(owners[i] ?? "")) return false;
    if (i === 0) return false;
    // `LOCK IN SHARE MODE`, SQLite `INDEXED BY ix`
    if ((lw[i] === "share" && lw[i + 1] === "mode" && lw[i - 1] === "in") || (lw[i - 1] === "by" && lw[i - 2] === "indexed")) return false;
    const pv = sig[i - 1];
    if (pv.kind === "punct") return BARE_PUNCT.has(raw[i - 1]);
    return pv.kind === "word" && BARE_PREV.has(lw[i - 1]);
  };

  // function call detection: ident followed by "(" and not in a table-introducing position
  const isCall = (i: number): boolean => {
    if (!isP(i + 1, "(") || roles[i]) return false;
    if (lw[i] === "conflict" && isWordAt(i - 1) && lw[i - 1] === "on") return false; // `ON CONFLICT (id)`
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
          if (owner && !owner.table && !owner.opaque && !(ctes.has(w) && owner.parts.length === 1)) {
            mk("bad");
            flag(i, "table");
          } else if (owner?.table) hit(i, owner.table);
        } else if (!idx.hasSchema(w) && !ctes.has(w) && !(dialect === "oracle" && ["sys", "system", "public"].includes(w))) {
          mk("bad");
          flag(i, "schema");
        }
      }
      continue;
    }
    if (role === "collist") continue;
    const lref = colLists.get(i);
    if (lref) {
      if (lref.table) {
        if (lref.table.byName.has(w)) {
          mk("col");
          hit(i, lref.table, w);
        } else {
          mk("bad");
          flag(i, "column");
        }
      }
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
      // Oracle pseudo-columns of any table and of a sequence: `e.rowid`, `emp_seq.nextval`
      if (dialect === "oracle" && (w === "rowid" || w === "nextval" || w === "currval")) continue;
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
        if (tbl.byName.has(w)) {
          mk("col");
          hit(i, tbl, w);
        } else if (flagUnresolved && !opaque) {
          mk("bad");
          flag(i, "column");
        }
      }
      continue;
    }

    if (beforeDot) {
      // qualifier: alias, table or schema. Plain, red when it names nothing.
      const qref = byName.get(w);
      // Oracle `seq.nextval` / `seq.currval`: the qualifier is a sequence
      if (dialect === "oracle" && /^(nextval|currval)$/.test(lw[i + 2] ?? "") && !qref) continue;
      // PostgreSQL / SQLite `ON CONFLICT .. DO UPDATE SET c = excluded.c`: the row proposed for insertion
      if (w === "excluded" && !qref && lw.some((x, k) => x === "conflict" && isWordAt(k) && isWordAt(k - 1) && lw[k - 1] === "on")) continue;
      if (qref?.table) hit(i, qref.table);
      if (flagUnresolved && !role && refs.length > 0 && !anyOpaque && !byName.has(w) && !idx.hasSchema(w) && !ctes.has(w) && ["select", "with", "update", "delete", "insert"].includes(first)) {
        mk("bad");
        flag(i, "table");
      }
      continue;
    }

    // unqualified word / quoted identifier
    if (t.kind === "qident") {
      if (resolvedRefs.length && scopeColumn(w)) {
        mk("col");
        hit(i, resolvedRefs.find((r) => r.table?.byName.has(w))!.table!, w);
      } else if (flagUnresolved && bareJudged(i)) {
        mk("bad");
        flag(i, "column");
      }
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
      hit(i, resolvedRefs.find((r) => r.table?.byName.has(w))!.table!, w);
      continue;
    }
    if (kws.has(w)) {
      mk("kw");
      continue;
    }
    if (flagUnresolved && bareJudged(i)) {
      mk("bad");
      flag(i, "column");
    }
  }
  marks.sort((a, b) => a.from - b.from);
  return { marks, scope, unresolved, resolved };
}
