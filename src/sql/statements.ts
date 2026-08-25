// Splits SQL text into statements by ';' delimiters OUTSIDE strings/comments/$...$ blocks.
// Shared by: current statement identification (Ctrl+Enter) and cursor statement highlighting.
import { maskCommentsAndStrings } from '../utils/queryParamHelper';

// Postgres dollar-quote opening: $ or $tag$ (avoids matching bind param $1
// or query parameter ${name}).
const DOLLAR_TAG = /^\$([A-Za-z_]\w*)?\$/;

// MySQL client DELIMITER command (not sent to server): changes statement delimiter
// allowing trigger/procedure bodies to contain ';'. Must occupy its own line.
const DELIMITER_CMD = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?$/i;

// Script contains DELIMITER -> treated as MySQL dialect; Postgres dollar-quotes are not applied,
// preventing `DELIMITER $` from erroneously masking trigger bodies.

function usesDelimiterCommand(sql: string): boolean {
  return /^[ \t]*DELIMITER[ \t]+\S+/im.test(sql);
}

/**
 * Full masking for statement splitting: comments + strings, PLUS Postgres dollar-quotes
 * (`$ ... $`, `$body$ ... $body// Splits SQL text into statements by ';' delimiters OUTSIDE strings/comments/$...$ blocks.
// Shared by: current statement identification (Ctrl+Enter) and cursor statement highlighting.
import { maskCommentsAndStrings } from '../utils/queryParamHelper';

// Postgres dollar-quote opening: $ or $tag$ (avoids matching bind param $1
// or query parameter ${name}).
const DOLLAR_TAG = /^\$([A-Za-z_]\w*)?\$/;

// MySQL client DELIMITER command (not sent to server): changes statement delimiter
// allowing trigger/procedure bodies to contain ';'. Must occupy its own line.
const DELIMITER_CMD = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*\r?$/i;

// Script contains DELIMITER -> treated as MySQL dialect; Postgres dollar-quotes are not applied,
// preventing `DELIMITER $` from erroneously masking trigger bodies.

function usesDelimiterCommand(sql: string): boolean {
  return /^[ \t]*DELIMITER[ \t]+\S+/im.test(sql);
}

/**
 * Full masking for statement splitting: comments + strings, PLUS Postgres dollar-quotes
 ) where bodies contain embedded semicolons.
 
 *
 * Returns string of equal length with masked regions replaced by spaces.
 */
export function maskForSplit(sql: string): string {
  const base = maskCommentsAndStrings(sql);
  if (usesDelimiterCommand(sql)) return base; // MySQL script -> '$' is delimiter, not quote block
  const out = base.split('');
  let i = 0;
  while (i < sql.length) {
    // Only considers positions that are real code (outside strings/comments from first pass)
    if (sql[i] === '$' && base[i] === '$') {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        for (let k = i; k < end; k++) out[k] = sql[k] === '\n' ? '\n' : ' ';
        i = end;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

export interface StatementRange {
  /** Start character offset (leading whitespace trimmed) */
  start: number;
  /** End character offset, excluding delimiter (trailing whitespace trimmed) */
  end: number;
  text: string;
}

// Trims boundaries; returns null if segment is only whitespace or comments.
function trimRange(text: string, mask: string, from: number, to: number): StatementRange | null {
  let s = from;
  let e = to;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s >= e) return null;
  // Comment-only -> masked to spaces -> not an executable statement
  if (!mask.slice(s, e).trim()) return null;
  return { start: s, end: e, text: text.slice(s, e) };
}

/** Table reference in FROM/JOIN/UPDATE/INTO. */
export interface TableRef {
  table: string;
  alias?: string;
}

// Keywords that may follow table name without being aliases.
const ALIAS_STOP_WORDS = [
  'on', 'where', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'join', 'group',
  'order', 'limit', 'set', 'using', 'values', 'select', 'having', 'union', 'and', 'or',
];

/**
 * `FROM|JOIN|UPDATE|INTO <table> [AS] [alias]`.
 *
 * Keywords excluded via lookahead to prevent skipping subsequent JOIN clauses.
 
 
 */
const TABLE_REF_SOURCE =
  '\\b(?:from|join|update|into)\\s+([`"\\[\\]\\w.]+)' +
  `(?:\\s+(?:as\\s+)?(?!(?:${ALIAS_STOP_WORDS.join('|')})\\b)([a-zA-Z_]\\w*))?`;

/**
 * Tables referenced in statement in appearance order.
 *
 * Fallback source for hover and completion during mid-typing when AST parsers fail.
 
 
 
 
 *
 * Order preserved for JOIN condition inference on the latest table.
 */
export function collectTableRefs(statement: string): TableRef[] {
  const out: TableRef[] = [];
  // Fresh RegExp instance per call to isolate global state across calls.
  const re = new RegExp(TABLE_REF_SOURCE, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(statement)) !== null) {
    const table = (m[1] || '').replace(/[`"[\]]/g, '').split('.').pop() || '';
    if (!table) continue;
    out.push({ table, alias: m[2] || undefined });
  }
  return out;
}

// `WITH` starts CTE list; parses `name [(cols)] AS [[NOT] MATERIALIZED] ( body )`.
// Uses sticky regex (`y`) for positional matching on buffer.

const CTE_RECURSIVE = /recursive\b/iy;
const CTE_NAME = /[`"[]?([A-Za-z_]\w*)[`"\]]?/y;
const CTE_AS = /as\b/iy;
const CTE_MATERIALIZED = /(?:not\s+)?materialized\b/iy;

/**
 * Lowercase names of CTEs declared in `WITH ... AS (...)`.
 *
 * Distinguishes local CTE aliases from actual database catalog tables.
 
 
 
 *
 * Scans masked text; jumps over CTE body via balanced parenthesis counting.
 
 
 
 *
 * Halts on unexpected syntax (`SELECT * FROM t WITH (NOLOCK)`).
 
 */
export function collectCteNames(sql: string): Set<string> {
  const out = new Set<string>();
  if (!sql) return out;
  const masked = maskForSplit(sql);

  const skipWs = (from: number) => {
    let i = from;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    return i;
  };
  /** Offset of matching ')' for '(' at `open`, or -1 if incomplete. */
  const closeParen = (open: number) => {
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')' && --depth === 0) return i;
    }
    return -1;
  };
  /** Matches `re` at offset `i`; returns offset after match, or -1. */
  const eat = (re: RegExp, i: number) => {
    re.lastIndex = i;
    const m = re.exec(masked);
    return m ? re.lastIndex : -1;
  };

  const withRe = /\bwith\b/gi;
  let w: RegExpExecArray | null;
  while ((w = withRe.exec(masked)) !== null) {
    let i = skipWs(w.index + w[0].length);
    const afterRecursive = eat(CTE_RECURSIVE, i);
    if (afterRecursive >= 0) i = skipWs(afterRecursive);

    // Comma-separated CTE list.
    for (;;) {
      CTE_NAME.lastIndex = i;
      const name = CTE_NAME.exec(masked);
      if (!name) break;
      i = skipWs(CTE_NAME.lastIndex);

      // Optional column list: `WITH t (a, b) AS (...)`.
      if (masked[i] === '(') {
        const cols = closeParen(i);
        if (cols < 0) break;
        i = skipWs(cols + 1);
      }

      const afterAs = eat(CTE_AS, i);
      if (afterAs < 0) break;
      i = skipWs(afterAs);

      const afterMat = eat(CTE_MATERIALIZED, i);
      if (afterMat >= 0) i = skipWs(afterMat);

      if (masked[i] !== '(') break;
      const body = closeParen(i);
      if (body < 0) break;

      out.add(name[1].toLowerCase());
      i = skipWs(body + 1);
      if (masked[i] !== ',') break;
      i = skipWs(i + 1);
    }
  }
  return out;
}

/**
 * Non-column tokens in SELECT list (clauses, keywords, literals).
 *
 * Prevents false squigglies on subqueries and expressions.
 
 
 */
const NON_COLUMN_WORDS = new Set([
  'distinct', 'all', 'as', 'case', 'when', 'then', 'else', 'end', 'null', 'true', 'false',
  'not', 'and', 'or', 'is', 'in', 'between', 'like', 'ilike', 'rlike', 'regexp', 'interval',
  'cast', 'collate', 'asc', 'desc', 'exists', 'any', 'some', 'array', 'row', 'over',
  'partition', 'by', 'order', 'filter', 'within', 'group', 'separator', 'escape', 'using',
  'current_date', 'current_time', 'current_timestamp', 'localtime', 'localtimestamp',
  'default', 'unknown', 'div', 'mod', 'binary', 'from',
  // Clause keywords: appear when SELECT item contains subquery; safely ignored.
  
  
  
  'select', 'where', 'having', 'limit', 'offset', 'fetch', 'join', 'on', 'inner', 'left',
  'right', 'outer', 'cross', 'natural', 'union', 'except', 'intersect', 'lateral', 'returning',
]);

/** SELECT list identifier with character offsets in statement. */
export interface BareColumnRef {
  name: string;
  offset: number;
}

/**
 * Unqualified column identifiers in SELECT list.
 * column: `SELECT ids FROM test` -> `ids`.
 *
 * Scopes strictly to SELECT list where typos commonly occur while avoiding false positives in complex WHERE/ORDER BY clauses.
 
 
 *
 * Four exclusions preventing false diagnostics:
 *  - dot-qualified identifiers (`t.id`, `db.t`) — handled by qualified checks;
 *  - tokens followed by `(` — function calls;
 *  - keywords and literals (`NULL`, `CASE`, `DISTINCT`...) — see `NON_COLUMN_WORDS`;
 *  - **defined aliases**: both `expr AS x` and implicit `expr x` shorthand.
 
 
 *
 * Returns empty array when unresolvable (lacks SELECT or top-level FROM).
 
 */
/** SELECT list item with character offsets in statement. */
export interface SelectListItem {
  text: string;
  offset: number;
}

/**
 * Splits SELECT list into items by top-level commas at depth 0.
 *
 * Separated from `collectSelectListRefs` because GROUP BY validation operates per item.
 
 
 *
 * Text extracted from masked copy: identifiers preserved while strings/comments are whitespace.
 
 
 */
export function selectListItems(statement: string): SelectListItem[] {
  const masked = maskForSplit(statement);
  const head = /^\s*select\s+(?:distinct\s+|all\s+)?/i.exec(masked);
  if (!head) return [];

  // `FROM` at paren depth 0 — `FROM` inside a subquery does not terminate top-level SELECT list.
  let depth = 0;
  let fromAt = -1;
  const scan = /[()]|\bfrom\b/gi;
  scan.lastIndex = head[0].length;
  let s: RegExpExecArray | null;
  while ((s = scan.exec(masked)) !== null) {
    if (s[0] === '(') depth++;
    else if (s[0] === ')') depth--;
    else if (depth === 0) { fromAt = s.index; break; }
  }
  if (fromAt < 0) return [];

  const list = masked.slice(head[0].length, fromAt);
  const base = head[0].length;
  const out: SelectListItem[] = [];
  let itemStart = 0;
  depth = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === '(') depth++;
    else if (list[i] === ')') depth--;
    else if (list[i] === ',' && depth === 0) {
      out.push({ text: list.slice(itemStart, i), offset: base + itemStart });
      itemStart = i + 1;
    }
  }
  out.push({ text: list.slice(itemStart), offset: base + itemStart });
  return out;
}

export function collectSelectListRefs(statement: string): BareColumnRef[] {
  const out: BareColumnRef[] = [];
  const ident = /[A-Za-z_]\w*/g;
  for (const { text: item, offset: itemOffset } of selectListItems(statement)) {
    const toks: { name: string; at: number }[] = [];
    ident.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ident.exec(item)) !== null) {
      const at = m.index;
      const before = item.slice(0, at).trimEnd();
      const after = item.slice(at + m[0].length);
      if (before.endsWith('.')) continue;              // `t.id` -> qualified column
      if (/^\s*\./.test(after)) continue;              // `t` trong `t.id`
      if (/^\s*\(/.test(after)) continue;              // function call
      toks.push({ name: m[0], at });
    }
    if (!toks.length) continue;

    // Alias: trailing token of item following `AS` or completed expression.
    const last = toks[toks.length - 1];
    const between = item.slice(0, last.at).trimEnd();
    const isAlias =
      /\bas$/i.test(between) ||
      (toks.length > 1 && /[\w`"\])]$/.test(between));
    const usable = isAlias ? toks.slice(0, -1) : toks;

    for (const tk of usable) {
      if (NON_COLUMN_WORDS.has(tk.name.toLowerCase())) continue;
      out.push({ name: tk.name, offset: itemOffset + tk.at });
    }
  }
  return out;
}

// Aggregate functions: SELECT item containing aggregate is valid under GROUP BY.


const AGGREGATE_FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'total',
  'group_concat', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg', 'json_arrayagg',
  'json_objectagg', 'listagg', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop',
  'var_samp', 'bit_and', 'bit_or', 'bit_xor', 'bool_and', 'bool_or', 'every', 'percentile_cont',
  'percentile_disc', 'corr', 'covar_pop', 'covar_samp',
]);

/** Does SELECT item contain an aggregate function call? */
export function hasAggregate(item: string): boolean {
  const re = /([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(item)) !== null) {
    if (AGGREGATE_FUNCTIONS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Identifiers listed in `GROUP BY` clause, or `null` if clause is absent.
 *
 * Distinguishes `null` (no GROUP BY) from `[]` (unresolvable GROUP BY like `GROUP BY 1`).
 
 
 */
export function groupByRefs(statement: string): BareColumnRef[] | null {
  const masked = maskForSplit(statement);

  // `GROUP BY` at paren depth 0 — subquery clauses belong to subquery.
  let depth = 0;
  let at = -1;
  const scan = /[()]|\bgroup\s+by\b/gi;
  let s: RegExpExecArray | null;
  while ((s = scan.exec(masked)) !== null) {
    if (s[0] === '(') depth++;
    else if (s[0] === ')') depth--;
    else if (depth === 0) { at = s.index + s[0].length; break; }
  }
  if (at < 0) return null;

  // Clause terminates at next top-level keyword.
  const tail = masked.slice(at);
  const stop = /\b(having|order\s+by|limit|offset|window|union|except|intersect|fetch|for)\b/i.exec(tail);
  const clause = tail.slice(0, stop ? stop.index : tail.length);

  if (/(^|,)\s*\d+\s*(,|$)/.test(clause)) return []; // Positional GROUP BY 1 -> skip

  const out: BareColumnRef[] = [];
  const ident = /[A-Za-z_]\w*/g;
  let m: RegExpExecArray | null;
  while ((m = ident.exec(clause)) !== null) {
    const after = clause.slice(m.index + m[0].length);
    if (/^\s*\(/.test(after)) continue;                       // function call
    if (NON_COLUMN_WORDS.has(m[0].toLowerCase())) continue;
    out.push({ name: m[0], offset: at + m.index });
  }
  return out;
}

/** Statement type used solely for outline icon selection. */
export type StatementKind = 'select' | 'write' | 'ddl' | 'other';

export interface StatementOutline {
  kind: StatementKind;
  /** Display label: verb + primary target, e.g. `SELECT users`, `CREATE TABLE orders`. */
  label: string;
}

// Leading statement verb. `with` is recognized to scan past CTE and find core verb.


const STATEMENT_VERBS = new Set([
  'with', 'select', 'insert', 'update', 'delete', 'merge', 'replace',
  'create', 'alter', 'drop', 'truncate', 'rename', 'comment',
  'grant', 'revoke', 'set', 'use', 'begin', 'start', 'commit', 'rollback', 'savepoint',
  'explain', 'analyze', 'show', 'describe', 'desc', 'call', 'do', 'vacuum', 'pragma',
]);

/** Object type following CREATE/ALTER/DROP for clear outline labels (`CREATE TABLE x`). */
const DDL_OBJECTS = new Set([
  'table', 'view', 'index', 'trigger', 'function', 'procedure', 'schema', 'database',
  'sequence', 'type', 'event', 'user', 'role', 'extension', 'materialized',
]);

/** Filler tokens between DDL verb and object type — skipped during parsing. */
const DDL_FILLERS = new Set([
  'or', 'replace', 'temporary', 'temp', 'unique', 'if', 'not', 'exists', 'global', 'local',
  'fulltext', 'spatial', 'clustered', 'nonclustered', 'concurrently', 'recursive', 'unlogged',
]);

/**
 * Short descriptive statement label for outline and breadcrumbs.
 *
 * Finds leading verb at paren depth 0 on masked text, extracting primary table/object target.
 
 
 *
 * Fallback returns statement prefix rather than empty string.
 
 */
export function describeStatement(statement: string): StatementOutline {
  const masked = maskForSplit(statement);

  // First verb at depth 0. `with` continues search past CTE definitions.
  let depth = 0;
  let verb = '';
  let verbEnd = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth !== 0 || !/[A-Za-z_]/.test(c)) continue;
    let j = i;
    while (j < masked.length && /\w/.test(masked[j])) j++;
    const word = masked.slice(i, j).toLowerCase();
    i = j - 1;
    if (!STATEMENT_VERBS.has(word)) continue;
    if (word === 'with') continue;
    verb = word;
    verbEnd = j;
    break;
  }

  const firstWords = statement.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!verb) return { kind: 'other', label: firstWords || 'SQL' };

  const rest = statement.slice(verbEnd);
  const upper = verb.toUpperCase();

  if (verb === 'select' || verb === 'delete') {
    const table = collectTableRefs(statement)[0]?.table;
    return {
      kind: verb === 'select' ? 'select' : 'write',
      label: table ? `${upper} ${table}` : upper,
    };
  }
  if (verb === 'insert' || verb === 'replace' || verb === 'merge') {
    const m = /\b(?:into)\s+([`"[\]\w.]+)/i.exec(rest) || /^\s*([`"[\]\w.]+)/.exec(rest);
    return { kind: 'write', label: m ? `${upper} ${clean(m[1])}` : upper };
  }
  if (verb === 'update' || verb === 'truncate' || verb === 'call') {
    const m = /^\s*(?:table\s+)?([`"[\]\w.]+)/i.exec(rest);
    return { kind: 'write', label: m ? `${upper} ${clean(m[1])}` : upper };
  }
  if (verb === 'create' || verb === 'alter' || verb === 'drop' || verb === 'comment') {
    // Skips qualifier tokens (`OR REPLACE`, `IF NOT EXISTS`...) to extract object type and name.
    const words = rest.trim().split(/\s+/);
    let object = '';
    let name = '';
    for (const w of words) {
      const bare = clean(w).toLowerCase();
      if (!bare) continue;
      if (!object) {
        if (DDL_FILLERS.has(bare)) continue;
        if (DDL_OBJECTS.has(bare)) { object = bare.toUpperCase(); continue; }
        name = clean(w);
        break;
      }
      if (DDL_FILLERS.has(bare)) continue;
      if (DDL_OBJECTS.has(bare)) { object += ` ${bare.toUpperCase()}`; continue; }
      name = clean(w);
      break;
    }
    const label = [upper, object, name].filter(Boolean).join(' ');
    return { kind: 'ddl', label: label || upper };
  }

  return { kind: 'other', label: firstWords };
}

/** Strips identifier quotes and trailing semicolons. */
function clean(raw: string): string {
  return raw.replace(/[`"[\]();]/g, '').trim();
}

/** Cursor is at position for filling column **value**. */
export interface ValuePosition {
  /** Left-hand column identifier, preserving table prefix (`u.status`). */
  column: string;
  /** Has user typed opening quote — determines whether completion auto-inserts quotes. */
  quoted: boolean;
}

// Value completion patterns (equality, IN list, LIKE).

const VALUE_AFTER_OP = /([`"[\]\w.]+)\s*(?:=|<>|!=|>=|<=|<|>)\s*(')?$/;
const VALUE_AFTER_LIKE = /([`"[\]\w.]+)\s+(?:not\s+)?like\s*(')?$/i;
const VALUE_IN_LIST = /([`"[\]\w.]+)\s+(?:not\s+)?in\s*\(\s*(?:'(?:[^']|'')*'\s*,\s*)*(')?$/i;

/**
 * Detects if cursor is in value position for a column, and identifies the column.
 *
 * Matches `WHERE status = `, `WHERE status = '`, `WHERE status IN (`, `IN ('a', `, `LIKE `.
 * Inspects text preceding cursor; reliable during mid-typing.
 *
 * Slices trailing buffer before regex evaluation for performance.
 
 */
export function valuePosition(textBefore: string): ValuePosition | null {
  const tail = textBefore.slice(-200);
  for (const re of [VALUE_AFTER_OP, VALUE_AFTER_LIKE, VALUE_IN_LIST]) {
    const m = re.exec(tail);
    if (!m) continue;
    const column = m[1].replace(/[`"[\]]/g, '');
    // Numeric literals are not columns (`WHERE 1 = `); skipped.
    if (!column || /^\d+$/.test(column)) return null;
    return { column, quoted: m[2] === "'" };
  }
  return null;
}

/** Function call enclosing the cursor position. */
export interface EnclosingCall {
  /** Function name as typed. */
  name: string;
  /** Active argument index, 0-indexed. */
  activeParam: number;
}

/**
 * Identifies function enclosing `offset` and the active argument index.
 *
 * Scans backward counting parentheses: depth 0 opening paren marks the enclosing call.
 Commas at depth 0 count argument positions: `concat(a, foo(b, c), |)` resolves to index 2.
 
 *
 * Runs on masked copy so parens/commas inside strings or comments are ignored.
 Semicolons at depth 0 halt search.
 *
 * Function name must directly precede opening paren without whitespace to avoid false matches (`SELECT (a + b)`).
 
 
 */
export function enclosingCall(text: string, offset: number): EnclosingCall | null {
  const masked = maskForSplit(text);
  let depth = 0;
  let commas = 0;
  for (let i = Math.min(offset, masked.length) - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth > 0) { depth--; continue; }
      const name = /([A-Za-z_]\w*)$/.exec(masked.slice(0, i));
      return name ? { name: name[1], activeParam: commas } : null;
    } else if (depth === 0) {
      if (c === ',') commas++;
      else if (c === ';') return null;
    }
  }
  return null;
}

/**
 * Alias -> table map in statement. Reuses parser logic from `collectTableRefs`.
 * so hover and completion resolve aliases consistently.
 * Placed here (independent of Monaco) for isolated testing.
 */
export function resolveAliases(statement: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const { table, alias } of collectTableRefs(statement)) {
    map.set(table.toLowerCase(), table);
    if (alias) map.set(alias.toLowerCase(), table);
  }
  return map;
}

/**
 * Does the statement alter DB schema (DDL) or switch database/schema?
 * Used to invalidate catalog cache immediately after execution to expose new tables to autocomplete/hover.
 *
 * `USE db` (MySQL) and `SET search_path` (Postgres) are included: backend switches to
 * another database/schema, making cached tables stale.
 * Scanned on masked copy so keywords inside strings/comments are ignored.
 */
export function isSchemaChangingSql(text: string): boolean {
  if (!text) return false;
  const masked = maskForSplit(text);
  return /\b(CREATE|ALTER|DROP|RENAME|TRUNCATE|USE)\b/i.test(masked)
    || /\bCOMMENT\s+ON\b/i.test(masked)
    || /\bSET\s+search_path\b/i.test(masked);
}

/**
 * Shared core: masks text once, then splits into SEGMENTS by ';' (including empty segments,
 * needed to detect when cursor sits between semicolons with no statement to run).
 */
// Is `text[i..]` the active delimiter, located outside strings/comments/$ blocks?
function matchesDelimiter(text: string, mask: string, i: number, delim: string): boolean {
  for (let k = 0; k < delim.length; k++) {
    const c = text[i + k];
    if (c !== delim[k] || mask[i + k] !== c) return false;
  }
  return true;
}

// Is line start at `i` a `DELIMITER <token>` command? Returns new token + offset after line.
function matchDelimiterCommand(
  text: string,
  mask: string,
  i: number
): { delim: string; end: number } | null {
  const nl = text.indexOf('\n', i);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(i, lineEnd);
  const m = DELIMITER_CMD.exec(line);
  if (!m) return null;
  // 'DELIMITER' token must be real code (inside strings/comments is not a command)
  const lead = line.length - line.trimStart().length;
  if (mask[i + lead] !== text[i + lead]) return null;
  return { delim: m[1], end: nl === -1 ? text.length : nl + 1 };
}

// Start of a CREATE TRIGGER statement (SQLite/MySQL/Postgres share this prefix).
// Matches against ORIGINAL text: MySQL allows `DEFINER=`root`@`localhost``,
// where masking clears backtick contents to spaces, breaking `\S+`.
const TRIGGER_HEAD = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:DEFINER\s*=\s*\S+\s+)?TRIGGER\b/i;
// `BEGIN` as a distinct token in code (masked so BEGIN in strings/comments is ignored).
const BEGIN_WORD = /\bBEGIN\b/i;

/**
 * Does [from, to) end with `END` keyword (ignoring trailing whitespace/comments).
 *
 * Read on masked text so `-- END` or string 'END' is ignored.
 */
function endsWithEndKeyword(mask: string, from: number, to: number): boolean {
  let e = to;
  while (e > from && /\s/.test(mask[e - 1])) e--;
  if (e - from < 3) return false;
  if (mask.slice(e - 3, e).toUpperCase() !== 'END') return false;
  const before = e - 4 >= from ? mask[e - 4] : ' ';
  return !/[A-Za-z0-9_$]/.test(before);
}

/**
 * Does this ';' sit INSIDE a trigger body?
 *
 * A `BEGIN ... END` trigger body contains internal ';', so splitting on ';' produces
 * truncated `CREATE TRIGGER ... BEGIN UPDATE t SET ...;` — SQLite errors with "incomplete input" and
 * the entire dump import rolls back. MySQL avoids this via `DELIMITER`, but SQLite lacks it,
 * so we detect it here: matching `sqlite3_complete()` rules — a statement
 * starting with CREATE TRIGGER only ends at ';' directly following the `END` keyword.
 *
 * `BEGIN` requirement is mandatory: Postgres triggers (`... EXECUTE FUNCTION f();`) and
 * single-statement MySQL triggers (`... FOR EACH ROW SET NEW.a = 1;`) lack BEGIN...END,
 * and waiting for `END` would skip the real delimiter and consume the rest of the dump.
 */
function insideTriggerBody(text: string, mask: string, from: number, to: number): boolean {
  // First real code character: mask converted comments to spaces, skipping leading comments.
  // preceding the statement.
  let s = from;
  while (s < to && /\s/.test(mask[s])) s++;
  if (!TRIGGER_HEAD.test(text.slice(s, to))) return false;
  // BEGIN/END read on masked copy: 'BEGIN' in strings or comments ignored.
  if (!BEGIN_WORD.test(mask.slice(s, to))) return false;
  return !endsWithEndKeyword(mask, s, to);
}

/**
 * Shared core: masks text once, then splits into SEGMENTS by active statement delimiter
 * (default ';', changeable via MySQL `DELIMITER`). Retains empty segments to detect
 * if cursor sits between delimiters where no executable statement exists.
 *
 * The `DELIMITER ...` line itself is NEVER included in any segment: client-only command,
 * sending it to server causes syntax error.
 */
function scanSegments(text: string): { mask: string; segments: [number, number][] } {
  const mask = maskForSplit(text);
  const segments: [number, number][] = [];
  let from = 0;
  let delim = ';';
  let atLineStart = true;
  let i = 0;

  while (i < text.length) {
    if (atLineStart) {
      const cmd = matchDelimiterCommand(text, mask, i);
      if (cmd) {
        segments.push([from, i]); // portion before statement (typically whitespace -> skipped)
        delim = cmd.delim;
        from = cmd.end;
        i = cmd.end;
        atLineStart = true;
        continue;
      }
    }
    if (matchesDelimiter(text, mask, i, delim)) {
      // Only applies when delimiter is ';': MySQL scripts with custom delimiter protect
      // trigger bodies through that mechanism directly.
      if (delim === ';' && insideTriggerBody(text, mask, from, i)) {
        i += 1;
        atLineStart = false;
        continue;
      }
      segments.push([from, i]);
      i += delim.length;
      from = i;
      atLineStart = false; // statement delimiter is never a newline character
      continue;
    }
    atLineStart = text[i] === '\n';
    i++;
  }

  segments.push([from, text.length]);
  return { mask, segments };
}

// Segment containing `offset`: cursor DIRECTLY AFTER ';' belongs to next segment (like DataGrip/DBeaver).
function pickCurrent(
  text: string,
  mask: string,
  segments: [number, number][],
  offset: number
): StatementRange | null {
  for (const [from, to] of segments) {
    if (offset <= to) return trimRange(text, mask, from, to);
  }
  return null;
}

/** List of statements in text (excluding empty / comment-only segments). */
export function splitStatements(text: string): StatementRange[] {
  if (!text) return [];
  const { mask, segments } = scanSegments(text);
  const out: StatementRange[] = [];
  for (const [from, to] of segments) {
    const r = trimRange(text, mask, from, to);
    if (r) out.push(r);
  }
  return out;
}

/** Statement type subject to confirmation before execution. */
export type UnsafeStatementKind = 'deleteNoWhere' | 'dropTable' | 'updateNoWhere' | 'truncate';

export interface UnsafeStatement {
  kind: UnsafeStatementKind;
  /** Verbatim statement (trimmed) shown in warning modal. */
  text: string;
}

/**
 * Finds statements that may erase data due to missing conditions:
 *   - `DELETE FROM ...` without `WHERE` -> deletes all rows in table
 *   - `DROP TABLE ...`                   -> drops the entire table
 *
 * For WARNING only, not blocking: unconditional `DELETE FROM tmp_import` is completely valid,
 * so final decision rests with user (to strictly block writes, enable Read-Only mode).
 *
 * Scanned on masked text (`maskForSplit`) so keywords in strings/comments/quoted identifiers
 * are ignored. Two notable outcomes, both following the safe path:
 *   - `DELETE FROM t -- WHERE id=1` IS warned (WHERE inside comment, does not run).
 *   - `DELETE FROM t WHERE note='drop table x'` is NOT warned (string masked).
 */
export function findUnsafeStatements(text: string): UnsafeStatement[] {
  if (!text) return [];
  const out: UnsafeStatement[] = [];
  for (const stmt of splitStatements(text)) {
    const masked = maskForSplit(stmt.text);
    // Covers multi-table MySQL syntax (`DELETE t1 FROM t1 JOIN t2 ...`) starting with DELETE.
    if (/^\s*DELETE\b/i.test(masked)) {
      if (!/\bWHERE\b/i.test(masked)) out.push({ kind: 'deleteNoWhere', text: stmt.text });
    } else if (/^\s*UPDATE\b/i.test(masked)) {
      // Same rationale as DELETE: missing WHERE overwrites ALL rows, non-rollbackable if
      // in auto-commit mode.
      if (!/\bWHERE\b/i.test(masked)) out.push({ kind: 'updateNoWhere', text: stmt.text });
    } else if (/^\s*DROP\s+(TEMPORARY\s+)?TABLE\b/i.test(masked)) {
      out.push({ kind: 'dropTable', text: stmt.text });
    } else if (/^\s*TRUNCATE\b/i.test(masked)) {
      // TRUNCATE erases table and implicitly commits on MySQL, so even open manual
      // transactions cannot rollback — equally or more destructive than unconstrained `DELETE`.
      out.push({ kind: 'truncate', text: stmt.text });
    }
  }
  return out;
}

/** Statement under cursor at `offset` (null if no executable statement at cursor). */
export function statementAt(text: string, offset: number): StatementRange | null {
  if (!text) return null;
  const { mask, segments } = scanSegments(text);
  return pickCurrent(text, mask, segments, offset);
}

/**
 * Both statement list and cursor statement, masking text ONCE only.
 * Used for syntax highlighting (runs on keystrokes) — calling splitStatements + statementAt separately
 * would mask twice and cause lag when holding Backspace on large scripts.
 */
export function analyzeStatements(
  text: string,
  offset: number
): { statements: StatementRange[]; current: StatementRange | null } {
  if (!text) return { statements: [], current: null };
  const { mask, segments } = scanSegments(text);
  const statements: StatementRange[] = [];
  for (const [from, to] of segments) {
    const r = trimRange(text, mask, from, to);
    if (r) statements.push(r);
  }
  return { statements, current: pickCurrent(text, mask, segments, offset) };
}
