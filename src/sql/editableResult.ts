// Decides whether a SQL result grid can be edited in place: whether every row shown maps
// 1-to-1 onto a row of exactly one real table, and every editable cell onto a real column
// of that table.
//
// Deliberately NOT built on `collectTableRefs()`, even though that is the obvious candidate.
// It is a regex over `from|join|update|into` tuned to stay useful on half-typed SQL, and its
// identifier character class does not match '(' — so `SELECT * FROM (SELECT * FROM users) x`
// reports a single ref to `users` and would green-light editing a derived table. Completion
// wants a forgiving scan; this wants the opposite, a whitelist that rejects anything it does
// not fully understand, because the cost of a false positive here is a wrong UPDATE. Only
// the masking helper is shared with that file.
//
// No monaco / no `@tauri-apps/api` import, and the schema lookup is injected — same reason
// as `joinConditions.ts`, so this stays unit-testable under the node environment.
import { maskForSplit } from './statements';

/** Minimal structural shape of what `catalog.getCachedSchema()` returns. */
export interface EditableSchemaColumn {
  name: string;
  isPrimaryKey?: boolean;
}
export interface EditableSchemaLike {
  columns: EditableSchemaColumn[];
}

export type NotEditableReason =
  | 'readOnlyMode'     // the app-wide Read-only switch is on — never produced here, see below
  | 'notSelect'        // not a SELECT at all (INSERT/UPDATE/DDL/…)
  | 'notSimple'        // CTE, set operation, DISTINCT, GROUP BY, HAVING — rows are not table rows
  | 'multiTable'       // JOIN, or a comma-separated FROM list
  | 'derivedTable'     // FROM (SELECT …)
  | 'computedColumns'  // the select list holds an expression, a function call or an alias
  | 'unknownTable'     // the table's schema is not cached (yet)
  | 'noPrimaryKey'     // no primary key, or a composite one (commit_changes takes one column)
  | 'pkNotSelected';   // the primary key is not among the returned columns

export interface EditableTarget {
  editable: true;
  table: string;
  /** Single-column primary key — the WHERE clause `commit_changes` builds needs exactly one. */
  primaryKey: string;
  /** Result columns that map onto a real column of `table`; anything else stays read-only. */
  columns: string[];
}

export interface NotEditableTarget {
  editable: false;
  reason: NotEditableReason;
  /** Set when the table name was resolved but the check failed later — lets the caller warm the schema cache and retry. */
  table?: string;
}

export type ResultEditability = EditableTarget | NotEditableTarget;

/** Identifier, optionally quoted per dialect. */
const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_]\\w*)';
/** A select-list item that is a plain (optionally qualified) column reference or a star. */
const PLAIN_COLUMN_RE = new RegExp(`^\\s*(?:${IDENT}\\s*\\.\\s*)?(?:${IDENT}|\\*)\\s*$`);
/** Clauses that end the FROM clause. */
const AFTER_FROM_RE =
  /\b(where|group|order|having|limit|offset|fetch|window|union|intersect|except|for)\b/gi;

function stripQuotes(ident: string): string {
  const s = ident.trim();
  if (/^`.*`$/.test(s) || /^".*"$/.test(s) || /^\[.*\]$/.test(s)) return s.slice(1, -1);
  return s;
}

/**
 * Paren depth at every offset. A '(' carries the depth *outside* it, so a top-level '('
 * reads as 0 and the text it encloses reads as 1 — which is what "top level" checks want.
 */
function depthAt(masked: string): number[] {
  const out = new Array<number>(masked.length);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') {
      out[i] = depth;
      depth++;
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
      out[i] = depth;
    } else {
      out[i] = depth;
    }
  }
  return out;
}

/** First match of `re` inside [from, to) that sits at paren depth 0. */
function firstTopLevel(masked: string, depth: number[], re: RegExp, from: number, to: number): number {
  const scan = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  scan.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = scan.exec(masked)) !== null) {
    if (m.index >= to) return -1;
    if (depth[m.index] === 0) return m.index;
  }
  return -1;
}

/** Offsets of the top-level commas inside [from, to). */
function topLevelCommas(masked: string, depth: number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    if (masked[i] === ',' && depth[i] === 0) out.push(i);
  }
  return out;
}

const CLOSING_QUOTE: Record<string, string> = { '`': '`', '"': '"', '[': ']' };

/**
 * Reads `[schema.]table [[AS] alias]` out of a FROM clause, or null if it holds anything else.
 *
 * A left-to-right tokenizer rather than one regex over the slice, because the two strings
 * disagree on purpose: a quoted identifier is real text in `sql` but blank in `masked`, while
 * a comment is the reverse. So identifiers are read from `sql` (quotes intact) and only the
 * leftover tail is validated against `masked`, where a trailing comment has become spaces.
 */
function readTableRef(sql: string, masked: string, from: number, to: number): string | null {
  let i = from;
  const skipSpace = () => { while (i < to && /\s/.test(sql[i])) i++; };

  /** One identifier: quoted (delimiters kept in `sql`) or bare. */
  const readIdent = (): string | null => {
    if (i >= to) return null;
    const close = CLOSING_QUOTE[sql[i]];
    if (close) {
      const end = sql.indexOf(close, i + 1);
      if (end === -1 || end >= to) return null;
      const raw = sql.slice(i + 1, end);
      i = end + 1;
      return raw;
    }
    const m = /^[A-Za-z_]\w*/.exec(sql.slice(i, to));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };

  skipSpace();
  let name = readIdent();
  if (name === null) return null;

  // `schema.table` — keep the last part, the backend resolves against the current schema.
  skipSpace();
  if (i < to && sql[i] === '.') {
    i++;
    skipSpace();
    name = readIdent();
    if (name === null) return null;
    skipSpace();
  }

  // Optional alias. `AS` is optional too, so a bare word here is the alias.
  const alias = /^(?:as\s+)?[A-Za-z_]\w*/i.exec(sql.slice(i, to));
  if (alias) i += alias[0].length;

  // Everything left must be whitespace in `sql` or blanked in `masked` (a trailing comment).
  for (; i < to; i++) {
    if (!/\s/.test(sql[i]) && masked[i] !== ' ') return null;
  }
  return name;
}

/**
 * `sql` is one statement (the query behind one result tab), `resultColumns` the column
 * names the backend returned for it, `getSchema` a synchronous cache read.
 *
 * This answers "does this result map onto table rows", nothing else — the app-wide Read-only
 * switch is layered on top by the caller (`readOnlyMode`), so this function keeps reporting the
 * structural reason and the schema-warming effect in `SqlEditor` keeps working while it is on.
 *
 * Matching between result columns and schema columns is **case-sensitive on purpose**: the
 * returned name becomes an identifier in the generated `UPDATE … SET "<name>" = …`, and on
 * Postgres a case-folded guess would address a different column. A name that does not match
 * exactly is simply left read-only rather than repaired.
 */
export function resolveResultEditability(
  sql: string,
  resultColumns: string[],
  getSchema: (table: string) => EditableSchemaLike | null
): ResultEditability {
  if (!sql || resultColumns.length === 0) return { editable: false, reason: 'notSelect' };

  const masked = maskForSplit(sql);
  // The mask is the same length as the source, so one pair of offsets indexes both.
  //
  // Leading: trim on the MASK, so a leading comment (blanked there) is skipped — safe because
  // an accepted statement has to start with SELECT/WITH, never with a masked token.
  // Trailing: trim on the SOURCE plus real semicolons, NOT on the mask. A quoted table name is
  // blank in the mask too, so `SELECT * FROM \`users\`` would otherwise have its table trimmed
  // away. A trailing comment therefore survives into `o` and is dealt with by `readTableRef`.
  let start = 0;
  let end = sql.length;
  while (start < end && /\s/.test(masked[start])) start++;
  while (end > start && (/\s/.test(sql[end - 1]) || masked[end - 1] === ';')) end--;

  const m = masked.slice(start, end);
  const o = sql.slice(start, end);
  if (!m) return { editable: false, reason: 'notSelect' };

  // A CTE returns rows of the CTE, not of a table, even when its body reads one table.
  if (/^with\b/i.test(m)) return { editable: false, reason: 'notSimple' };
  if (!/^select\b/i.test(m)) return { editable: false, reason: 'notSelect' };

  if (/\bjoin\b/i.test(m)) return { editable: false, reason: 'multiTable' };
  if (/\b(union|intersect|except)\b/i.test(m)) return { editable: false, reason: 'notSimple' };
  if (/\b(distinct|having)\b/i.test(m) || /\bgroup\s+by\b/i.test(m)) {
    return { editable: false, reason: 'notSimple' };
  }

  const depth = depthAt(m);
  const fromIdx = firstTopLevel(m, depth, /\bfrom\b/i, 0, m.length);
  if (fromIdx < 0) return { editable: false, reason: 'notSimple' }; // `SELECT 1`, `SELECT NOW()`

  // ── select list ────────────────────────────────────────────────────────────────────
  const selFrom = 'select'.length;
  const commas = topLevelCommas(m, depth, selFrom, fromIdx);
  const bounds = [selFrom, ...commas.map(i => i + 1)];
  const ends = [...commas, fromIdx];

  let star = false;
  const selected: string[] = [];
  for (let k = 0; k < bounds.length; k++) {
    const mItem = m.slice(bounds[k], ends[k]);
    const oItem = o.slice(bounds[k], ends[k]);
    // Parens are checked on the mask so a function call is caught while a paren living
    // inside a quoted identifier is not.
    if (mItem.includes('(') || !PLAIN_COLUMN_RE.test(oItem)) {
      return { editable: false, reason: 'computedColumns' };
    }
    const bare = stripQuotes(oItem.trim().split('.').pop() || '');
    if (bare === '*') star = true;
    else selected.push(bare);
  }

  // ── FROM clause ────────────────────────────────────────────────────────────────────
  const afterFrom = fromIdx + 'from'.length;
  const clauseEnd = firstTopLevel(m, depth, AFTER_FROM_RE, afterFrom, m.length);
  const fromEnd = clauseEnd < 0 ? m.length : clauseEnd;

  if (topLevelCommas(m, depth, afterFrom, fromEnd).length > 0) {
    return { editable: false, reason: 'multiTable' };
  }
  if (m.slice(afterFrom, fromEnd).trim().startsWith('(')) {
    return { editable: false, reason: 'derivedTable' };
  }

  const table = readTableRef(o, m, afterFrom, fromEnd);
  if (!table) return { editable: false, reason: 'multiTable' };

  // ── schema ─────────────────────────────────────────────────────────────────────────
  const schema = getSchema(table);
  if (!schema) return { editable: false, reason: 'unknownTable', table };

  const pks = schema.columns.filter(c => c.isPrimaryKey);
  // Exactly one: `commit_changes` takes `primaryKey: string` and builds a single-column
  // WHERE, so a composite key would address the wrong rows.
  if (pks.length !== 1) return { editable: false, reason: 'noPrimaryKey', table };
  const primaryKey = pks[0].name;

  if (!resultColumns.includes(primaryKey)) {
    return { editable: false, reason: 'pkNotSelected', table };
  }

  const schemaNames = new Set(schema.columns.map(c => c.name));
  // `star` widens the accepted set to every real column; an explicit list is additionally
  // narrowed to what was actually asked for, so a stale cache cannot re-add a dropped column.
  const asked = star ? null : new Set(selected);
  const columns = resultColumns.filter(c => schemaNames.has(c) && (asked === null || asked.has(c)));
  if (columns.length === 0) return { editable: false, reason: 'computedColumns', table };

  return { editable: true, table, primaryKey, columns };
}
