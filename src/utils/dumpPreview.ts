/**
 * Parser "vừa đủ" for phần preview tệp dump at popup Nhập database:
 * read CREATE TABLE thành danh sách column, and INSERT INTO thành các row giá trị,
 * to display dạng table trực quan bên cạnh dạng SQL thô.
 *
 * Chỉ phục vụ display — statement run thật do backend (split_sql_statements) handle.
 */

import i18n from '../i18n';

export interface DumpColumn {
  name: string;
  /** Phần kiểu + phần còn lại of định nghĩa column, ví dụ "varchar(255) NOT NULL". */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
}

export interface DumpTable {
  name: string;
  columns: DumpColumn[];
  /** constraint mức table: PRIMARY KEY (...), FOREIGN KEY ..., UNIQUE KEY ..., CHECK ... */
  constraints: string[];
}

export interface DumpRows {
  table: string;
  /** null when INSERT not liệt kê column. */
  columns: string[] | null;
  rows: string[][];
}

// Identifier can kèm dấu bao (`x`, "x", [x]) and schema đứng trước (public."Trip").
const IDENT = '((?:[A-Za-z0-9_$]|[`"\'\\[\\]]|\\.)+)';

/** Bỏ dấu bao quanh identifier and phần schema đứng trước, lấy tên trần. */
function unquoteIdent(raw: string): string {
  const cleaned = raw.trim().replace(/[`"'[\]]/g, '');
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot + 1) : cleaned;
}

/** Cắt theo dấu phẩy at mức ngoặc ngoài cùng, skip phẩy in string/ngoặc lồng. */
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
        // '' bên in string is quotes escape, not must kết thúc string
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
 * position dấu ')' close cặp ngoặc open tại `start` (skip ngoặc lồng and ngoặc in string),
 * -1 if not close. `start` must trỏ ando một dấu '('.
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

/** Lấy nội dung in cặp ngoặc ngoài cùng đầu tiên. */
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

/** Parse một statement CREATE TABLE. returns null if not must CREATE TABLE. */
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

  // PRIMARY KEY (a, b) at mức table -> đánh dấu lại ando column for dễ read.
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
 * scan tên database mà tệp dump nhắm tới: ưu tiên `USE <db>`, sau đó
 * `CREATE DATABASE/SCHEMA <db>`. Trả null if tệp not nói database nào.
 */
export function parseDumpDatabase(sql: string): string | null {
  // Tên database allows cả '-' (valid when is bao dấu), khác IDENT of tên table/column.
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
 * Bỏ whitespace + comment at đầu statement. Bản song sinh of `strip_leading_comments()`
 * in database.rs: splitter giữ comment in text statement nên dump of mysqldump có
 * `-- Dumping data for table x` dán liền trước LOCK TABLES / INSERT.
 */
export function stripLeadingSqlComments(stmt: string): string {
  return stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

const SKIPPED_HEAD_RE = /^(?:LOCK\s+TABLES|UNLOCK\s+TABLES|START\s+TRANSACTION|BEGIN\b|COMMIT|ROLLBACK)/i;

/**
 * statement of dump mà restore not run lại (xem `is_skipped_stmt()` at database.rs):
 * LOCK/UNLOCK TABLES and các lệnh transaction. Dùng to đếm số statement will run for khớp backend.
 */
export function isSkippedDumpStatement(stmt: string): boolean {
  return isSkippedDumpBody(stripLeadingSqlComments(stmt));
}

/**
 * Như `isSkippedDumpStatement` nhưng receive sẵn phần already bỏ comment đầu — to nơi nào already strip rồi
 * thì not strip lại lần nữa (một tệp dump có row chục nghìn statement).
 */
export function isSkippedDumpBody(body: string): boolean {
  return SKIPPED_HEAD_RE.test(body);
}

/**
 * Câu chỉ còn comment sau when bỏ comment đầu: comment điều kiện of MySQL (`/*!40101 SET ... *​/`)
 * vẫn is lệnh thật nên có run; comment thường thì not.
 */
export function isCommentOnlyStatement(stmt: string): { commentOnly: boolean; willRun: boolean } {
  return commentOnlyFromBody(stmt, stripLeadingSqlComments(stmt));
}

/** Như `isCommentOnlyStatement` nhưng receive sẵn phần already bỏ comment đầu (khỏi strip hai lần). */
export function commentOnlyFromBody(stmt: string, body: string): { commentOnly: boolean; willRun: boolean } {
  if (body.length > 0) return { commentOnly: false, willRun: true };
  return { commentOnly: true, willRun: stmt.includes('/*!') };
}

/**
 * Đầu statement giới thiệu một đối tượng of dump, ngay trước tên of nó.
 *
 * Có cả VIEW: dump write view bằng `CREATE ... VIEW` / `DROP VIEW IF EXISTS` (not must
 * `DROP TABLE`), nên if chỉ scan table thì view not lọt ando danh sách select — and backend chỉ
 * run statement nào có nhắc một tên in danh sách đó (`stmt_mentions_table`), tức is lệnh
 * `DROP VIEW` of view is loại and lần nhập lại error "view already exists".
 */
const OBJECT_HEAD =
  '(?:CREATE\\s+TABLE|INSERT\\s+INTO|DROP\\s+(?:TABLE|VIEW|TRIGGER|PROCEDURE|FUNCTION)\\s+IF\\s+EXISTS' +
  '|CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\S+\\s+)?(?:DEFINER\\s*=\\s*\\S+\\s+)?' +
  '(?:SQL\\s+SECURITY\\s+\\w+\\s+)?(?:VIEW|TRIGGER|PROCEDURE|FUNCTION))';

const OBJECT_NAME_SRC = `${OBJECT_HEAD}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"']?([a-zA-Z0-9_]+)[\`"']?`;

// table TẠM khai báo in thân procedure/function — not must table of database.
const TEMP_TABLE_SRC = 'CREATE\\s+TEMPORARY\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[`"\']?([a-zA-Z0-9_]+)[`"\']?';

/**
 * Tên các table/view mà tệp dump nhắc tới, theo thứ tự xuất hiện.
 *
 * Đây is danh sách to user select nhập một phần, and cũng chính is bộ filter truyền xuống
 * `restore_backup`. table tạm bên in thân procedure/function is loại: chúng lọt ando qua
 * `INSERT INTO <temp>` nhưng not must đối tượng of database.
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

/** Tên table/view of MỘT statement (to filter preview theo table currently select); null if not scan is. */
export function dumpStatementObject(stmt: string): string | null {
  const m = new RegExp(OBJECT_NAME_SRC, 'i').exec(stmt);
  return m ? m[1] : null;
}

/** Các đối tượng mà tệp dump will create — dùng to delete cái trùng tên trước when run lại. */
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

/** Liệt kê đối tượng is create in dump (table, view, trigger, procedure, function). */
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
 * build các lệnh DROP ... IF EXISTS to run lại một dump lên database already có sẵn đối tượng
 * trùng tên (if not, `CREATE TABLE` will error "already exists" and cả lần nhập is rollback).
 *
 * Thứ tự: trigger -> view -> routine -> table. Khác biệt theo dialect:
 *   - Postgres: `DROP TRIGGER` cần kèm `ON <table>` and `DROP FUNCTION` cần chữ ký -> skip,
 *     chỉ delete table/view with CASCADE.
 *   - SQLite: not có procedure/function.
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
 * error "đối tượng already tồn tại" (MySQL 1050, Postgres 42P07, SQLite "already exists") not nói
 * for user biết must ism gì -> suggestion bật option write đè.
 */
export function addExistsHint(error: string, overwriteAlreadyOn: boolean): string {
  const isExists = /already exists|1050|42P07/i.test(error);
  if (!isExists || overwriteAlreadyOn) return error;
  return i18n.t('errors.existsHint', { error });
}

/** Bỏ quotes of một literal SQL to display (NULL preserve chữ NULL). */
function literalToText(raw: string): string {
  const s = raw.trim();
  if (/^'([\s\S]*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  return s;
}

/** Parse một statement INSERT INTO. returns null if not must INSERT. */
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
    // Mỗi tuple is một cặp ngoặc at mức ngoài cùng: (...),(...). Đi bằng chỉ số thay vì cắt
    // dần phần còn lại: export gộp tới 500 row ando một INSERT, and slice theo fromng tuple ism
    // việc này thành O(n²) on một statement dài row trăm nghìn character.
    let i = 0;
    while (i < tuplesPart.length) {
      while (i < tuplesPart.length && /[\s,]/.test(tuplesPart[i])) i++;
      // not còn tuple nào -> phần đuôi is thứ khác (ON DUPLICATE KEY UPDATE, RETURNING...).
      if (tuplesPart[i] !== '(') break;
      const end = matchingParen(tuplesPart, i);
      if (end < 0) break;
      rows.push(splitTopLevel(tuplesPart.slice(i + 1, end)).map(literalToText));
      i = end + 1;
    }
  }

  return { table, columns, rows };
}
