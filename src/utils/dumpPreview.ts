/**
 * Parser "vừa đủ" cho phần xem trước tệp dump ở popup Nhập Cơ sở dữ liệu:
 * đọc CREATE TABLE thành danh sách cột, và INSERT INTO thành các dòng giá trị,
 * để hiển thị dạng bảng trực quan bên cạnh dạng SQL thô.
 *
 * Chỉ phục vụ hiển thị — câu lệnh chạy thật do backend (split_sql_statements) xử lý.
 */

export interface DumpColumn {
  name: string;
  /** Phần kiểu + phần còn lại của định nghĩa cột, ví dụ "varchar(255) NOT NULL". */
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
}

export interface DumpTable {
  name: string;
  columns: DumpColumn[];
  /** Ràng buộc mức bảng: PRIMARY KEY (...), FOREIGN KEY ..., UNIQUE KEY ..., CHECK ... */
  constraints: string[];
}

export interface DumpRows {
  table: string;
  /** null khi INSERT không liệt kê cột. */
  columns: string[] | null;
  rows: string[][];
}

// Identifier có thể kèm dấu bao (`x`, "x", [x]) và schema đứng trước (public."Trip").
const IDENT = '((?:[A-Za-z0-9_$]|[`"\'\\[\\]]|\\.)+)';

/** Bỏ dấu bao quanh identifier và phần schema đứng trước, lấy tên trần. */
function unquoteIdent(raw: string): string {
  const cleaned = raw.trim().replace(/[`"'[\]]/g, '');
  const dot = cleaned.lastIndexOf('.');
  return dot >= 0 ? cleaned.slice(dot + 1) : cleaned;
}

/** Cắt theo dấu phẩy ở mức ngoặc ngoài cùng, bỏ qua phẩy trong chuỗi/ngoặc lồng. */
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
        // '' bên trong chuỗi là dấu nháy escape, không phải kết thúc chuỗi
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

/** Lấy nội dung trong cặp ngoặc ngoài cùng đầu tiên. */
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

/** Parse một câu lệnh CREATE TABLE. Trả về null nếu không phải CREATE TABLE. */
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

  // PRIMARY KEY (a, b) ở mức bảng -> đánh dấu lại vào cột cho dễ đọc.
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
 * Dò tên database mà tệp dump nhắm tới: ưu tiên `USE <db>`, sau đó
 * `CREATE DATABASE/SCHEMA <db>`. Trả null nếu tệp không nói database nào.
 */
export function parseDumpDatabase(sql: string): string | null {
  // Tên database cho phép cả '-' (hợp lệ khi được bao dấu), khác IDENT của tên bảng/cột.
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
 * Bỏ khoảng trắng + comment ở đầu câu lệnh. Bản song sinh của `strip_leading_comments()`
 * trong database.rs: splitter giữ comment trong text câu lệnh nên dump của mysqldump có
 * `-- Dumping data for table x` dán liền trước LOCK TABLES / INSERT.
 */
export function stripLeadingSqlComments(stmt: string): string {
  return stmt.replace(/^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
}

const SKIPPED_HEAD_RE = /^(?:LOCK\s+TABLES|UNLOCK\s+TABLES|START\s+TRANSACTION|BEGIN\b|COMMIT|ROLLBACK)/i;

/**
 * Câu lệnh của dump mà restore KHÔNG chạy lại (xem `is_skipped_stmt()` ở database.rs):
 * LOCK/UNLOCK TABLES và các lệnh transaction. Dùng để đếm số câu lệnh sẽ chạy cho khớp backend.
 */
export function isSkippedDumpStatement(stmt: string): boolean {
  return SKIPPED_HEAD_RE.test(stripLeadingSqlComments(stmt));
}

/**
 * Câu chỉ còn comment sau khi bỏ comment đầu: comment điều kiện của MySQL (`/*!40101 SET ... *​/`)
 * vẫn là lệnh thật nên có chạy; comment thường thì không.
 */
export function isCommentOnlyStatement(stmt: string): { commentOnly: boolean; willRun: boolean } {
  const body = stripLeadingSqlComments(stmt);
  if (body.length > 0) return { commentOnly: false, willRun: true };
  return { commentOnly: true, willRun: stmt.includes('/*!') };
}

/** Các đối tượng mà tệp dump sẽ tạo — dùng để xoá cái trùng tên trước khi chạy lại. */
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

/** Liệt kê đối tượng được tạo trong dump (bảng, view, trigger, procedure, function). */
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
 * Dựng các lệnh DROP ... IF EXISTS để chạy lại một dump lên database đã có sẵn đối tượng
 * trùng tên (nếu không, `CREATE TABLE` sẽ lỗi "already exists" và cả lần nhập bị rollback).
 *
 * Thứ tự: trigger -> view -> routine -> table. Khác biệt theo dialect:
 *   - Postgres: `DROP TRIGGER` cần kèm `ON <table>` và `DROP FUNCTION` cần chữ ký -> bỏ qua,
 *     chỉ xoá bảng/view với CASCADE.
 *   - SQLite: không có procedure/function.
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
 * Lỗi "đối tượng đã tồn tại" (MySQL 1050, Postgres 42P07, SQLite "already exists") không nói
 * cho người dùng biết phải làm gì -> gợi ý bật tuỳ chọn ghi đè.
 */
export function addExistsHint(error: string, overwriteAlreadyOn: boolean): string {
  const isExists = /already exists|1050|42P07/i.test(error);
  if (!isExists || overwriteAlreadyOn) return error;
  return `${error}\n\nGợi ý: database đích đã có đối tượng trùng tên. Bật "Ghi đè đối tượng trùng tên" để xoá rồi tạo lại, hoặc chọn một database đích khác.`;
}

/** Bỏ dấu nháy của một literal SQL để hiển thị (NULL giữ nguyên chữ NULL). */
function literalToText(raw: string): string {
  const s = raw.trim();
  if (/^'([\s\S]*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  return s;
}

/** Parse một câu lệnh INSERT INTO. Trả về null nếu không phải INSERT. */
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
    // Mỗi tuple là một cặp ngoặc ở mức ngoài cùng: (...),(...)
    let rest = tuplesPart;
    while (rest.trim().startsWith('(') || rest.includes('(')) {
      const tuple = outerParens(rest);
      if (tuple === null) break;
      rows.push(splitTopLevel(tuple).map(literalToText));
      const close = rest.indexOf(')', rest.indexOf('(') + tuple.length);
      if (close < 0) break;
      rest = rest.slice(close + 1);
      if (!rest.includes('(')) break;
      // Chỉ tiếp tục nếu phần còn lại vẫn là danh sách tuple (tránh ăn vào ON DUPLICATE...)
      if (!/^\s*,/.test(rest)) break;
    }
  }

  return { table, columns, rows };
}
