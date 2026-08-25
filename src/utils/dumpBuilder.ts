// build nội dung tệp .sql (dump) for cả hai đường xuất of app.
//
// Trước đây có HAI bản: khối này nằm in `App.tsx` (popup "Xuất database") and một bản
// Rust `export_multi_tables` (Connection Manager -> Backup). Bản Rust not phân biệt view with
// table nên sinh `DROP TABLE`/`INSERT INTO` for view, write một `INSERT` for MỖI row, not báo
// is tiến độ, and tất nhiên not có routine/trigger. Mọi thứ edit for popup đều not tới
// is nút Backup — nên bản Rust already is delete and cả hai nơi cùng gọi `buildDump()` at đây.
//
// Truy cập database đi qua tham số `reader` chứ not import `dbHelper` trực tiếp: giữ for
// module này not phụ thuộc `@tauri-apps/api`, nhờ vậy thứ tự các statement in dump —
// phần dễ hỏng nhất and cũng quan trọng nhất — kiểm chứng is bằng unit test.
import i18n from '../i18n';
import type { SchemaInfo } from './dbHelper';
import { buildSql, isBinaryType, orderViewsByDependency, stripDefiner, wrapMysqlDelimiter } from './exportHelper';

/** Số row read mỗi lần gọi when rút dữ liệu table. */
export const EXPORT_PAGE_SIZE = 2000;

/** Phần dbHelper mà việc build dump cần tới. `dbHelper` khớp sẵn hình dạng này. */
export interface DumpReader {
  getTableDefinition(name: string): Promise<{ success: boolean; sql?: string; error?: string }>;
  getTableSchema(tableName: string): Promise<SchemaInfo>;
  getTableData(
    tableName: string,
    page?: number,
    pageSize?: number
  ): Promise<{ rows: any[]; totalCount: number | null }>;
  getObjectDefinition(
    name: string,
    kind: 'view' | 'function' | 'procedure' | 'table' | 'event'
  ): Promise<{ success: boolean; sql?: string; error?: string }>;
  getAllTriggers(): Promise<{ name: string; table: string; statement: string }[]>;
  getTableDdlExtras(tableName: string): Promise<{
    sequences: string[];
    indexes: string[];
    constraints: string[];
    comments: string[];
    sequenceValues: string[];
  }>;
}

/**
 * `dbHelper` bound to one connection, in the shape `buildDump` wants.
 *
 * `DumpReader` is deliberately an injected interface — that is what keeps `dumpBuilder` free of
 * `@tauri-apps/api` and unit-testable. Now that every read takes a `conn_id`, `dbHelper` no longer
 * *is* a `DumpReader`; this adapts it into one for a given connection, in one place, instead of
 * widening the interface with an id it has no use for.
 */
export function dumpReaderFor(
  db: {
    getTableDefinition(connId: string, name: string): Promise<{ success: boolean; sql?: string; error?: string }>;
    getTableSchema(connId: string, tableName: string): Promise<SchemaInfo>;
    getTableData(connId: string, tableName: string, page?: number, pageSize?: number): Promise<{ rows: any[]; totalCount: number | null }>;
    getObjectDefinition(connId: string, name: string, kind: 'view' | 'function' | 'procedure' | 'table' | 'event'): Promise<{ success: boolean; sql?: string; error?: string }>;
    getAllTriggers(connId: string): Promise<{ name: string; table: string; statement: string }[]>;
    getTableDdlExtras(connId: string, tableName: string): Promise<{
      sequences: string[]; indexes: string[]; constraints: string[]; comments: string[]; sequenceValues: string[];
    }>;
  },
  connId: string,
): DumpReader {
  return {
    getTableDefinition: (name) => db.getTableDefinition(connId, name),
    getTableSchema: (t) => db.getTableSchema(connId, t),
    getTableData: (t, page, pageSize) => db.getTableData(connId, t, page, pageSize),
    getObjectDefinition: (name, kind) => db.getObjectDefinition(connId, name, kind),
    getAllTriggers: () => db.getAllTriggers(connId),
    getTableDdlExtras: (t) => db.getTableDdlExtras(connId, t),
  };
}

export interface DumpProgress {
  label: string;
  current?: number;
  total?: number;
  detail?: string;
}

export interface DumpSpec {
  dbType: string;
  /** table and view (giống `DatabaseExportOptions.tables`). */
  tables: string[];
  /** Tên nào in `tables` is view. */
  views: string[];
  routines: { name: string; kind: 'function' | 'procedure' }[];
  triggers: string[];
  /** MySQL scheduled event — write cùng khối DELIMITER with routine. */
  events?: string[];
  /**
   * Schema Postgres mà dump này is read ra from đó. Chỉ dùng to viết header (xem `dumpHeader`);
   * mọi DDL bên in vẫn to tên trần, nên tệp còn nhập lại is ando schema tên khác.
   */
  schema?: string | null;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  onProgress?: (p: DumpProgress) => void;
}

const fmtNum = (n: number) => n.toLocaleString(i18n.language);

/** Định danh Postgres in statement sinh ra: luôn bọc nháy kép, nhân đôi nháy kép bên in. */
function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Lệnh cấp phiên open đầu tệp dump.
 *
 * `restore_backup` bên in app vốn already tự lo mã hoá and foreign key, nên những row này not
 * must to phục vụ nút Nhập — chúng to tệp còn run is bằng `mysql < dump.sql`, `psql -f`
 * hay `sqlite3 <` at ngoài. at đó not có ai tắt check foreign key hộ, mà table thì xuất theo
 * thứ tự alphabet, nên `city` tham chiếu `country` is vỡ ngay.
 *
 * Bộ filter theo table of `restore_backup` for `SET …` and `PRAGMA …` luôn run and coi error of
 * chúng is not nwriteêm trọng (`is_session_level_stmt`), nên dump of dialect khác cũng not
 * chết vì mấy row này.
 *
 * `schema` (chỉ Postgres, chỉ when khác `public`): tệp xuất from schema `sales` mà nhập lại not
 * có hai row này thì mọi đối tượng chui ando schema đầu `search_path` of máy đích — thường is
 * `public` — tức is **nhập nhầm chỗ mà not báo error gì**. write at header thay vì qualify fromng
 * câu DDL is cố ý: tên trần cộng `search_path` thì user đổi is schema đích chỉ bằng cách
 * edit một row, còn tên already qualify thì must edit cả tệp. `CREATE SCHEMA IF NOT EXISTS` đi kèm vì
 * `SET search_path` tới một schema chưa có is valid nhưng vô nghĩa — `CREATE TABLE` ngay sau đó
 * will error. Cả hai đều nằm in danh sách "lệnh cấp phiên" of `restore_backup`
 * (`is_session_level_stmt`) nên luôn run dù user chỉ select andi table.
 */
function dumpHeader(dbType: string, schema?: string | null): string[] {
  if (dbType === 'mysql') {
    return [
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      // not có row này thì giá trị 0 in column AUTO_INCREMENT is coi is "tự sinh đi" and
      // database nhập lại đánh số khác hẳn bản gốc. mysqldump cũng đặt đúng cờ này.
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      '',
    ];
  }
  if (dbType === 'postgres') {
    const sch = (schema || '').trim();
    return [
      "SET client_encoding = 'UTF8';",
      // Literal nhị phân is write dạng '\xAB12'::bytea — tắt cờ này thì dấu \ thành character
      // escape and mọi BLOB nhập lại sai nội dung.
      'SET standard_conforming_strings = on;',
      // `public` not write ra: đó already is default of mọi search_path, and skip giữ for tệp
      // xuất from database thường not khác gì bản trước when có tính năng schema.
      ...(sch && sch !== 'public'
        ? [
            `CREATE SCHEMA IF NOT EXISTS ${quotePgIdent(sch)};`,
            `SET search_path TO ${quotePgIdent(sch)};`,
          ]
        : []),
      '',
    ];
  }
  // SQLite: bên in một transaction thì PRAGMA này is no-op (SQLite quy định vậy), nên nó
  // chỉ có tác dụng when run tệp bằng sqlite3 CLI — đúng chỗ cần.
  return ['PRAGMA foreign_keys = OFF;', ''];
}

/** Trả lại status phiên sau when load xong. */
function dumpFooter(dbType: string): string[] {
  if (dbType === 'mysql') return ['SET FOREIGN_KEY_CHECKS = 1;'];
  if (dbType === 'postgres') return [];
  return ['PRAGMA foreign_keys = ON;'];
}

/**
 * read hết row of một table theo trang.
 *
 * Tiến độ: mức ngoài is số table already xong (cộng phần trăm of table currently run), row phụ is %
 * row in table đó. read theo trang chứ not một phát: trước đây limit 100.000 row nên
 * table lớn is xuất thiếu mà not báo gì.
 */
export async function readTableRows(
  reader: Pick<DumpReader, 'getTableData'>,
  table: string,
  tableIndex: number,
  total: number,
  onProgress?: (p: DumpProgress) => void
): Promise<any[]> {
  const rows: any[] = [];
  let page = 1;
  let totalRows = 0;
  for (;;) {
    const data = await reader.getTableData(table, page, EXPORT_PAGE_SIZE);
    const batch = data.rows || [];
    rows.push(...batch);
    if (!totalRows && data.totalCount) totalRows = data.totalCount;
    const inner = totalRows ? Math.min(1, rows.length / totalRows) : 0;
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: tableIndex + 1, total, table }),
      current: tableIndex + inner,
      total,
      detail: totalRows
        ? i18n.t('app.exportRowsPct', {
            rows: fmtNum(rows.length),
            total: fmtNum(totalRows),
            pct: Math.round(inner * 100),
          })
        : i18n.t('app.exportRows', { rows: fmtNum(rows.length) }),
    });
    if (batch.length < EXPORT_PAGE_SIZE) break;
    if (totalRows && rows.length >= totalRows) break;
    page++;
  }
  return rows;
}

/**
 * Toàn bộ nội dung tệp .sql.
 *
 * Thứ tự các statement is thứ có ý nghĩa nhất at đây — **table -> view -> routine -> trigger**:
 *   - `CREATE VIEW` is check ngay lúc run, nên view đứng trước table mà nó SELECT is error
 *     luôn (MySQL 1146). Danh sách đối tượng theo alphabet nên view `actor_info` of sakila
 *     fromng đứng thứ hai, trước cả table `film`.
 *   - Giữa các view lại xếp theo phụ thuộc (`orderViewsByDependency`) vì view read is view khác.
 *   - Routine and trigger đứng cuối: thân chúng read table, and trigger còn can gọi hàm.
 * View not xuất dữ liệu: `INSERT INTO <view>` error when view not updatable, and những row đó
 * vốn already nằm in các table gốc rồi.
 */
export async function buildDump(spec: DumpSpec, reader: DumpReader): Promise<string> {
  const { onProgress, sqlOptions } = spec;
  const isMysql = spec.dbType === 'mysql';
  const isPostgres = spec.dbType === 'postgres';
  const q = isMysql ? '`' : '"';

  // Routine/trigger not có dữ liệu, chỉ có định nghĩa -> tắt "kèm cấu trúc" is chúng not
  // còn gì to xuất. Cộng ando tổng to thanh tiến độ not stop at 100% rồi vẫn run tiếp.
  const routineList = sqlOptions.includeStructure ? spec.routines : [];
  const triggerList = sqlOptions.includeStructure ? spec.triggers : [];
  const eventList = sqlOptions.includeStructure ? spec.events || [] : [];
  const total = spec.tables.length + routineList.length + triggerList.length + eventList.length;

  const parts: string[] = [
    '-- Database Backup generated by TableNova',
    `-- Date: ${new Date().toISOString()}`,
    '',
    ...dumpHeader(spec.dbType, spec.schema),
  ];

  const viewSet = new Set(spec.views.map((v) => v.toLowerCase()));
  const baseTables = spec.tables.filter((name) => !viewSet.has(name.toLowerCase()));
  const viewList = spec.tables.filter((name) => viewSet.has(name.toLowerCase()));

  // ALTER TABLE ... ADD CONSTRAINT gom lại, write sau when mọi table already tồn tại (xem chỗ push).
  const deferredConstraints: string[] = [];
  // setval() of sequence: must run sau when dữ liệu already ando, vì nó read MAX() of table.
  const deferredSequenceValues: string[] = [];

  const schemaFailed = (name: string, message?: string) =>
    i18n.t('app.exportSchemaFailed', {
      table: `${q}${name}${q}`,
      message: message || i18n.t('app.exportUnknownReason'),
    });

  for (let i = 0; i < baseTables.length; i++) {
    const table = baseTables[i];
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: i + 1, total, table }),
      current: i,
      total,
      detail: i18n.t('app.exportReadingSchema'),
    });

    // Những thứ đi kèm table mà CREATE TABLE of dialect not chứa (index, FK, comment,
    // sequence). MySQL returns rỗng vì SHOW CREATE TABLE already gói sẵn all.
    const extras = sqlOptions.includeStructure
      ? await reader.getTableDdlExtras(table)
      : { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
    // foreign key must đợi all table is create xong mới add is — table xuất theo thứ tự
    // alphabet, nên `city` tham chiếu `country` will error if gắn FK ngay tại chỗ.
    deferredConstraints.push(...extras.constraints);

    if (sqlOptions.dropTable) {
      parts.push(`DROP TABLE IF EXISTS ${q}${table}${q};`);
    }
    if (sqlOptions.includeStructure) {
      const def = await reader.getTableDefinition(table);
      if (def.success && def.sql) {
        parts.push(`-- Structure for table ${q}${table}${q}`);
        // Sequence đứng TRƯỚC table: column serial có DEFAULT nextval('...') and Postgres check
        // ngay lúc CREATE TABLE, thiếu sequence is restore chết at table đầu tiên.
        parts.push(...extras.sequences);
        const sql = def.sql.trim();
        parts.push(sql.endsWith(';') ? sql : sql + ';');
        parts.push(...extras.indexes);
        parts.push(...extras.comments);
      } else {
        parts.push(schemaFailed(table, def.error));
      }
      parts.push('');
    }
    if (sqlOptions.includeContent) {
      const rows = await readTableRows(reader, table, i, total, onProgress);
      if (rows.length > 0) {
        const schema = await reader.getTableSchema(table);
        const schemaCols = schema.columns || [];
        // column GENERATED/IDENTITY is loại khỏi INSERT: database tự tính chúng, write ando is error
        // (MySQL 3105, Postgres đòi OVERRIDING SYSTEM VALUE) and cả lần nhập is rollback.
        const colNames = schemaCols.filter((c) => !c.generated).map((c) => c.name);
        const cols = colNames.length ? colNames : Object.keys(rows[0]);
        // Ô nhị phân về đây is mảng byte; not đánh dấu thì nó is JSON.stringify thành
        // '[137,80,78,71,...]' and tệp gốc coi như mất.
        const binaryCols = new Set(
          schemaCols.filter((c) => isBinaryType(c.type, spec.dbType)).map((c) => c.name)
        );
        // column identity thì NGƯỢC LẠI with generated: giữ in INSERT to not mất id gốc,
        // nhưng statement must xin phép write đè.
        const needsOverriding = schemaCols.some((c) => c.identityAlways);
        parts.push(i18n.t('app.exportDataComment', { table: `${q}${table}${q}`, rows: rows.length }));
        parts.push(buildSql(table, cols, rows, spec.dbType, binaryCols, needsOverriding));
        parts.push('');
      }
      deferredSequenceValues.push(...extras.sequenceValues);
    }
    onProgress?.({
      label: i18n.t('app.exportTableProgress', { i: i + 1, total, table }),
      current: i + 1,
      total,
      detail: i18n.t('app.exportTableDone'),
    });
  }

  // foreign key and các constraint mức table khác: chỉ gắn is when MỌI table already tồn tại.
  if (deferredConstraints.length > 0) {
    parts.push('-- Constraints');
    parts.push(...deferredConstraints);
    parts.push('');
  }
  // setval() read MAX() of dữ liệu vừa load -> must sau toàn bộ INSERT. Thiếu nó thì sequence
  // quay về 1 and row chèn tiếp theo đụng primary key.
  if (deferredSequenceValues.length > 0) {
    parts.push('-- Sequence values');
    parts.push(...deferredSequenceValues);
    parts.push('');
  }

  // View: chỉ định nghĩa. Tắt "kèm cấu trúc" thì view not còn gì to xuất, and lệnh DROP of
  // nó cũng must im theo — DROP VIEW mà not có CREATE VIEW is delete trắng.
  if (sqlOptions.includeStructure && viewList.length > 0) {
    const viewDefs: { name: string; sql: string }[] = [];
    for (let i = 0; i < viewList.length; i++) {
      const view = viewList[i];
      const step = baseTables.length + i;
      onProgress?.({
        label: i18n.t('app.exportTableProgress', { i: step + 1, total, table: view }),
        current: step,
        total,
        detail: i18n.t('app.exportReadingSchema'),
      });
      const def = await reader.getTableDefinition(view);
      if (def.success && def.sql) {
        const sql = def.sql.trim();
        viewDefs.push({ name: view, sql: sql.endsWith(';') ? sql : sql + ';' });
      } else {
        parts.push(schemaFailed(view, def.error));
      }
      onProgress?.({
        label: i18n.t('app.exportTableProgress', { i: step + 1, total, table: view }),
        current: step + 1,
        total,
        detail: i18n.t('app.exportTableDone'),
      });
    }

    const cascade = isPostgres ? ' CASCADE' : '';
    for (const view of orderViewsByDependency(viewDefs)) {
      if (sqlOptions.dropTable) {
        // Materialized view cần đúng chữ MATERIALIZED in lệnh DROP; receive biết from chính DDL
        // vừa lấy về, khỏi must kéo add một trường "loại" xuyên qua cả string gọi.
        const isMatView = /^\s*CREATE\s+MATERIALIZED\s+VIEW\b/i.test(view.sql);
        const kw = isMatView ? 'MATERIALIZED VIEW' : 'VIEW';
        parts.push(`DROP ${kw} IF EXISTS ${q}${view.name}${q}${cascade};`);
      }
      parts.push(`-- Structure for view ${q}${view.name}${q}`);
      parts.push(stripDefiner(view.sql));
      parts.push('');
    }
  }

  if (routineList.length > 0 || triggerList.length > 0 || eventList.length > 0) {
    const drops: string[] = [];
    const creates: string[] = [];
    let step = baseTables.length + viewList.length;

    const reportStep = (name: string, done: boolean) => {
      onProgress?.({
        label: i18n.t('app.exportObjectProgress', { i: step + 1, total, name }),
        current: done ? step + 1 : step,
        total,
        detail: done ? i18n.t('app.exportTableDone') : i18n.t('app.exportReadingSchema'),
      });
    };

    for (const routine of routineList) {
      reportStep(routine.name, false);
      const def = await reader.getObjectDefinition(routine.name, routine.kind);
      if (def.success && def.sql) {
        // Postgres not cần DROP: pg_get_functiondef() returns CREATE OR REPLACE FUNCTION, and
        // DROP FUNCTION at đây thì must kèm chữ ký tham số mới delete đúng bản load chồng.
        if (sqlOptions.dropTable && isMysql) {
          const kw = routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
          drops.push(`DROP ${kw} IF EXISTS ${q}${routine.name}${q};`);
        }
        // pg_get_functiondef() returns định nghĩa not có dấu ';' at cuối, khác SHOW CREATE of
        // MySQL — thiếu thì câu sau is dính ando ism một. Bọc DELIMITER will tự bỏ dấu này.
        const sql = stripDefiner(def.sql.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(routine.name, def.error));
      }
      reportStep(routine.name, true);
      step++;
    }

    // Event chỉ có at MySQL, and thân nó (`DO BEGIN ... END`) cũng chứa dấu ';' như routine nên
    // đi chung khối DELIMITER phía under.
    for (const name of eventList) {
      reportStep(name, false);
      const def = await reader.getObjectDefinition(name, 'event');
      if (def.success && def.sql) {
        if (sqlOptions.dropTable) {
          drops.push(`DROP EVENT IF EXISTS ${q}${name}${q};`);
        }
        const sql = stripDefiner(def.sql.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(name, def.error));
      }
      reportStep(name, true);
      step++;
    }

    // Câu CREATE TRIGGER lấy một lần for cả database (get_all_triggers); Postgres còn cần tên
    // table chủ vì DROP TRIGGER of nó bắt buộc có `ON <table>`.
    const allTriggers = triggerList.length > 0 ? await reader.getAllTriggers() : [];
    const triggerByName = new Map(allTriggers.map((tr) => [tr.name, tr]));
    for (const name of triggerList) {
      reportStep(name, false);
      const tr = triggerByName.get(name);
      if (tr && tr.statement) {
        if (sqlOptions.dropTable) {
          drops.push(
            isPostgres
              ? `DROP TRIGGER IF EXISTS ${q}${name}${q} ON ${q}${tr.table}${q};`
              : `DROP TRIGGER IF EXISTS ${q}${name}${q};`
          );
        }
        const sql = stripDefiner(tr.statement.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(name));
      }
      reportStep(name, true);
      step++;
    }

    if (creates.length > 0) {
      parts.push('-- Routines and triggers');
      parts.push(...drops);
      // MySQL: thân routine/trigger có dấu ';' riêng nên must đổi delimiter, if not bộ tách
      // cắt ngay giữa thân. Postgres dùng $$ (cả hai bộ tách đều hiểu), SQLite thì khối
      // BEGIN...END is chính bộ tách receive diện.
      parts.push(...(isMysql ? wrapMysqlDelimiter(creates) : creates));
      parts.push('');
    }
  }

  parts.push(...dumpFooter(spec.dbType));
  return parts.join('\n');
}
