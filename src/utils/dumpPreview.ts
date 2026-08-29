/**
 * A "just enough" parser for the dump preview in the Import Database dialog: it reads a CREATE TABLE
 * into a column list and an INSERT INTO into value rows, so the visual table can be shown next to the
 * raw SQL.
 *
 * For display only — the statements that really run are handled by the backend
 * (split_sql_statements).
 */

import i18n from '../i18n';

export interface DumpColumn {
  name: string;
  /** The type plus the rest of the column definition, e.g. "varchar(255) NOT NULL". */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
}

export interface DumpTable {
  name: string;
  columns: DumpColumn[];
  /** Table-level constraints: PRIMARY KEY (...), FOREIGN KEY ..., UNIQUE KEY ..., CHECK ... */
  constraints: string[];
}

export interface DumpRows {
  table: string;
  /** null when the INSERT lists no columns. */
  columns: string[] | null;
  rows: string[][];
}

// An identifier may be quoted (`x`, "x", [x]) and may carry a schema prefix (public."Trip").
const IDENT = '((?:[A-Za-z0-9_$]|[`"\'\\[\\]]|\\.)+)';

/** Strips an identifier's quotes and any schema prefix, leaving the bare name. */
function unquoteIdent(raw: string): string {
  const cleaned = raw.trim().replace(/[`"'[\]]/g, '');
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot + 1) : cleaned;
}

/** Splits on commas at the outermost paren level, ignoring those inside strings or nested parens. */
function splitTopLevel(body: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { if (i + 1 < body.length) cur += body[++i]; continue; }
      if (ch === quote) {
        // A '' inside a string is an escaped quote, not the end of the string
        if (body[i + 1] === quote) { cur += body[++i]; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The position of the ')' closing the paren opened at `start` (ignoring nested parens and parens
 * inside strings), or -1 when it never closes. `start` has to point at a '('.
 */
function matchingParen(s: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (s[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Takes the contents of the first outermost paren pair. */
function outerParens(stmt: string): string | null {
  const start = stmt.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < stmt.length; i++) {
    const ch = stmt[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) {
        if (stmt[i + 1] === quote) { i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return stmt.slice(start + 1, i);
    }
  }
  return null;
}

const TABLE_CONSTRAINT_RE = /^(PRIMARY\s+KEY|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN\s+KEY|CHECK|EXCLUDE)\b/i;

/** Parses a CREATE TABLE statement. Returns null when it is not one. */
export function parseCreateTable(stmt: string): DumpTable | null {
  const head = new RegExp(`^\\s*CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'i').exec(stmt);
  if (!head) return null;
  const name = unquoteIdent(head[1]);
  const body = outerParens(stmt);
  if (!body) return { name, columns: [], constraints: [] };

  const columns: DumpColumn[] = [];
  const constraints: string[] = [];

  for (const part of splitTopLevel(body)) {
    if (TABLE_CONSTRAINT_RE.test(part)) {
      constraints.push(part.replace(/\s+/g, ' '));
      continue;
    }
    const m = new RegExp(`^${IDENT}\\s*([\\s\\S]*)$`).exec(part);
    if (!m) continue;
    const rest = (m[2] || '').replace(/\s+/g, ' ').trim();
    const def = /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(rest);
    columns.push({
      name: unquoteIdent(m[1]),
      type: rest || '—',
      notNull: /\bNOT\s+NULL\b/i.test(rest),
      primaryKey: /\bPRIMARY\s+KEY\b/i.test(rest),
      autoIncrement: /\b(AUTO_INCREMENT|AUTOINCREMENT|GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)\b/i.test(rest),
      defaultValue: def ? def[1] : null,
    });
  }

  // A table-level PRIMARY KEY (a, b) -> marked back onto the columns, to read more easily.
  for (const c of constraints) {
    const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(c);
    if (!pk) continue;
    for (const raw of splitTopLevel(pk[1])) {
      const col = columns.find((x) => x.name.toLowerCase() === unquoteIdent(raw).toLowerCase());
      if (col) col.primaryKey = true;
    }
  }

  return { name, columns, constraints };
}

/**
 * Detects the database a dump targets: `USE <db>` first, then `CREATE DATABASE/SCHEMA <db>`.
 * Returns null when the file names none.
 */
export function parseDumpDatabase(sql: string): string | null {
  // A database name may contain '-' (valid when quoted), unlike the IDENT used for table and column names.
  const DB_IDENT = '([`"\'\\[]?[A-Za-z0-9_$-]+[`"\'\\]]?)';
  const use = new RegExp(`\\bUSE\\s+${DB_IDENT}\\s*;`, 'i').exec(sql);
  if (use) {
    const name = unquoteIdent(use[1]);
    if (name) return name;
  }
  const create = new RegExp(
    `\\bCREATE\\s+(?:DATABASE|SCHEMA)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${DB_IDENT}`,
    'i'
  ).exec(sql);
  if (create) {
    const name = unquoteIdent(create[1]);
    if (name) return name;
  }
  return null;
}

/**
 * Strips leading whitespace and comments from a statement. The twin of `strip_leading_comments()` in
 * database.rs: the splitter keeps comments inside a statement's text, so a mysqldump file has
 * `-- Dumping data for table x` sitting immediately before its LOCK TABLES / INSERT.
 */
export function stripLeadingSqlComments(stmt: string): string {
  return stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

const SKIPPED_HEAD_RE = /^(?:LOCK\s+TABLES|UNLOCK\s+TABLES|START\s+TRANSACTION|BEGIN\b|COMMIT|ROLLBACK)/i;

/**
 * The dump statements a restore does NOT replay (see `is_skipped_stmt()` in database.rs):
 * LOCK/UNLOCK TABLES and the transaction statements. Used so the statement count matches the backend.
 */
export function isSkippedDumpStatement(stmt: string): boolean {
  return isSkippedDumpBody(stripLeadingSqlComments(stmt));
}

/**
 * Like `isSkippedDumpStatement` but takes the already-stripped text — so a caller that stripped the
 * leading comment does not strip it a second time (a dump holds tens of thousands of statements).
 */
export function isSkippedDumpBody(body: string): boolean {
  return SKIPPED_HEAD_RE.test(body);
}

/**
 * Statement containing only comments after stripping leading comments: MySQL conditional comments (`/*!40101 SET ... * /`)
 * remain executable statements, whereas standard comments do not.
 */
export function isCommentOnlyStatement(stmt: string): { commentOnly: boolean; willRun: boolean } {
  return commentOnlyFromBody(stmt, stripLeadingSqlComments(stmt));
}

/** Like `isCommentOnlyStatement` but takes the already-stripped text, to avoid stripping twice. */
export function commentOnlyFromBody(stmt: string, body: string): { commentOnly: boolean; willRun: boolean } {
  if (body.length > 0) return { commentOnly: false, willRun: true };
  return { commentOnly: true, willRun: stmt.includes('/*!') };
}

/**
 * The statement head that introduces one of the dump's objects, immediately before its name.
 *
 * VIEWs are included: a dump writes them with `CREATE ... VIEW` / `DROP VIEW IF EXISTS` and not with
 * `DROP TABLE`, so detecting tables alone leaves views out of the selection list — and the backend only
 * runs statements mentioning a name from that list (`stmt_mentions_table`), which drops the view's
 * `DROP VIEW` and makes the re-import fail with "view already exists".
 */
const OBJECT_HEAD =
  '(?:CREATE\\s+TABLE|INSERT\\s+INTO|DROP\\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION)\\s+IF\\s+EXISTS' +
  '|CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\S+\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?' +
  '(?:SQL\\s+SECURITY\\s+\\w+\\s+)?(?:VIEW|TRIGGER|PROCEDURE|FUNCTION))';

const OBJECT_NAME_SRC = `${OBJECT_HEAD}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"']?([a-zA-Z0-9_]+)[\`"']?`;

// TEMPORARY tables declared inside a procedure or function body — not tables of the database.
const TEMP_TABLE_SRC = 'CREATE\\s+TEMPORARY\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[`"\']?([a-zA-Z0-9_]+)[`"\']?';

/**
 * The table and view names a dump mentions, in the order they appear.
 *
 * This is the list the user picks from for a partial import, and it is also the filter passed down to
 * `restore_backup`. Temporary tables inside a procedure or function body are excluded: they slip in
 * through `INSERT INTO <temp>` but are not objects of the database.
 */
export function parseDumpTableNames(sql: string): string[] {
  const temps = new Set<string>();
  const tempRe = new RegExp(TEMP_TABLE_SRC, 'gi');
  let t: RegExpExecArray | null;
  while ((t = tempRe.exec(sql)) !== null) temps.add(t[1].toLowerCase());

  const found: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(OBJECT_NAME_SRC, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    if (temps.has(name.toLowerCase())) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
}

/** The table or view name of ONE statement (for filtering the preview by selection); null when undetectable. */
export function dumpStatementObject(stmt: string): string | null {
  const m = new RegExp(OBJECT_NAME_SRC, 'i').exec(stmt);
  return m ? m[1] : null;
}

/** The objects a dump will create — used to drop same-named ones before replaying it. */
export interface DumpObjects {
  tables: string[];
  views: string[];
  triggers: string[];
  procedures: string[];
  functions: string[];
}

function collectNames(sql: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = unquoteIdent(m[1]);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Lists the objects created in a dump (tables, views, triggers, procedures, functions). */
export function parseDumpObjects(sql: string): DumpObjects {
  const tables = collectNames(sql, new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'gi'));
  // CREATE [OR REPLACE] [ALGORITHM=..] [DEFINER=..] [SQL SECURITY ..] VIEW <name>
  const views = collectNames(
    sql,
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\S+\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?(?:SQL\\s+SECURITY\\s+\\w+\\s+)?VIEW\\s+${IDENT}`, 'gi')
  );
  const triggers = collectNames(sql, new RegExp(`CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?TRIGGER\\s+${IDENT}`, 'gi'));
  const procedures = collectNames(sql, new RegExp(`CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?PROCEDURE\\s+${IDENT}`, 'gi'));
  const functions = collectNames(sql, new RegExp(`CREATE\\s+(?:DEFINER\\s*=\\s*\\S+\\s+)?FUNCTION\\s+${IDENT}`, 'gi'));
  return { tables, views, triggers, procedures, functions };
}

/**
 * Builds the DROP ... IF EXISTS statements for replaying a dump onto a database that already holds
 * same-named objects (without them, `CREATE TABLE` fails with "already exists" and the whole import
 * rolls back).
 *
 * The order: triggers -> views -> routines -> tables. Per-dialect differences:
 *   - Postgres: `DROP TRIGGER` needs `ON <table>` and `DROP FUNCTION` needs a signature -> both are
 *     skipped, and only tables and views are dropped, with CASCADE.
 *   - SQLite: has no procedures or functions.
 */
export function buildDropStatements(objs: DumpObjects, dbType: string): string[] {
  const q = dbType === 'mysql' ? '`' : '"';
  const qi = (n: string) => `${q}${n}${q}`;
  const out: string[] = [];

  if (dbType === 'mysql') {
    for (const t of objs.triggers) out.push(`DROP TRIGGER IF EXISTS ${qi(t)};`);
    for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)};`);
    for (const p of objs.procedures) out.push(`DROP PROCEDURE IF EXISTS ${qi(p)};`);
    for (const f of objs.functions) out.push(`DROP FUNCTION IF EXISTS ${qi(f)};`);
    for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)};`);
    return out;
  }

  if (dbType === 'postgres') {
    for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)} CASCADE;`);
    for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)} CASCADE;`);
    return out;
  }

  // SQLite
  for (const t of objs.triggers) out.push(`DROP TRIGGER IF EXISTS ${qi(t)};`);
  for (const v of objs.views) out.push(`DROP VIEW IF EXISTS ${qi(v)};`);
  for (const t of objs.tables) out.push(`DROP TABLE IF EXISTS ${qi(t)};`);
  return out;
}

/**
 * An "object already exists" error (MySQL 1050, Postgres 42P07, SQLite "already exists") tells the
 * user nothing about what to do -> suggest turning the overwrite option on.
 */
export function addExistsHint(error: string, overwriteAlreadyOn: boolean): string {
  const isExists = /already exists|1050|42P07/i.test(error);
  if (!isExists || overwriteAlreadyOn) return error;
  return i18n.t('errors.existsHint', { error });
}

/** Strips the quotes from a SQL literal for display (NULL stays the word NULL). */
function literalToText(raw: string): string {
  const s = raw.trim();
  if (/^'([\s\S]*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  return s;
}

/** Parses an INSERT INTO statement. Returns null when it is not one. */
export function parseInsert(stmt: string): DumpRows | null {
  const head = new RegExp(`^\\s*INSERT(?:\\s+OR\\s+\\w+)?(?:\\s+IGNORE)?\\s+INTO\\s+${IDENT}`, 'i').exec(stmt);
  if (!head) return null;
  const table = unquoteIdent(head[1]);

  const afterName = stmt.slice(head[0].length);
  const valuesIdx = afterName.search(/\bVALUES?\b/i);
  const colsPart = valuesIdx >= 0 ? afterName.slice(0, valuesIdx) : afterName;
  const colsBody = outerParens(colsPart);
  const columns = colsBody ? splitTopLevel(colsBody).map(unquoteIdent) : null;

  const rows: string[][] = [];
  if (valuesIdx >= 0) {
    const tuplesPart = afterName.slice(valuesIdx).replace(/^\s*VALUES?\b/i, '');
    // Each tuple is one outermost paren pair: (...),(...). Walked by index rather than by repeatedly
    // slicing the remainder: the export batches up to 500 rows into one INSERT, and slicing per tuple
    // would make this O(n²) on a statement hundreds of thousands of characters long.
    let i = 0;
    while (i < tuplesPart.length) {
      while (i < tuplesPart.length && /[\s,]/.test(tuplesPart[i])) i++;
      // No tuples left -> what follows is something else (ON DUPLICATE KEY UPDATE, RETURNING…).
      if (tuplesPart[i] !== '(') break;
      const end = matchingParen(tuplesPart, i);
      if (end < 0) break;
      rows.push(splitTopLevel(tuplesPart.slice(i + 1, end)).map(literalToText));
      i = end + 1;
    }
  }

  return { table, columns, rows };
}
