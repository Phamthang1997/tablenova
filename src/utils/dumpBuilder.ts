// Dựng nội dung tệp .sql (dump) cho cả hai đường xuất của app.
//
// Trước đây có HAI bản: khối này nằm trong `App.tsx` (popup "Xuất Cơ sở dữ liệu") và một bản
// Rust `export_multi_tables` (Connection Manager -> Backup). Bản Rust không phân biệt view với
// bảng nên sinh `DROP TABLE`/`INSERT INTO` cho view, ghi một `INSERT` cho MỖI dòng, không báo
// được tiến độ, và tất nhiên không có routine/trigger. Mọi thứ sửa cho popup đều không tới
// được nút Backup — nên bản Rust đã bị xoá và cả hai nơi cùng gọi `buildDump()` ở đây.
//
// Truy cập database đi qua tham số `reader` chứ không import `dbHelper` trực tiếp: giữ cho
// module này không phụ thuộc `@tauri-apps/api`, nhờ vậy thứ tự các câu lệnh trong dump —
// phần dễ hỏng nhất và cũng quan trọng nhất — kiểm chứng được bằng unit test.
import i18n from '../i18n';
import type { SchemaInfo } from './dbHelper';
import { buildSql, isBinaryType, orderViewsByDependency, stripDefiner, wrapMysqlDelimiter } from './exportHelper';

/** Số dòng đọc mỗi lần gọi khi rút dữ liệu bảng. */
export const EXPORT_PAGE_SIZE = 2000;

/** Phần dbHelper mà việc dựng dump cần tới. `dbHelper` khớp sẵn hình dạng này. */
export interface DumpReader {
  getTableDefinition(name: string): Promise<{ success: boolean; sql?: string; error?: string }>;
  getTableSchema(tableName: string): Promise<SchemaInfo>;
  getTableData(
    tableName: string,
    page?: number,
    pageSize?: number
  ): Promise<{ rows: any[]; totalCount: number }>;
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
    getTableData(connId: string, tableName: string, page?: number, pageSize?: number): Promise<{ rows: any[]; totalCount: number }>;
    getObjectDefinition(connId: string, name: string, kind: 'view' | 'function' | 'procedure' | 'table' | 'event'): Promise<{ success: boolean; sql?: string; error?: string }>;
    getAllTriggers(): Promise<{ name: string; table: string; statement: string }[]>;
    getTableDdlExtras(tableName: string): Promise<{
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
    getAllTriggers: () => db.getAllTriggers(),
    getTableDdlExtras: (t) => db.getTableDdlExtras(t),
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
  /** Bảng VÀ view (giống `DatabaseExportOptions.tables`). */
  tables: string[];
  /** Tên nào trong `tables` là view. */
  views: string[];
  routines: { name: string; kind: 'function' | 'procedure' }[];
  triggers: string[];
  /** MySQL scheduled event — ghi cùng khối DELIMITER với routine. */
  events?: string[];
  /**
   * Schema Postgres mà dump này được đọc ra từ đó. Chỉ dùng để viết header (xem `dumpHeader`);
   * mọi DDL bên trong vẫn để tên trần, nên tệp còn nhập lại được vào schema tên khác.
   */
  schema?: string | null;
  sqlOptions: { dropTable: boolean; includeStructure: boolean; includeContent: boolean };
  onProgress?: (p: DumpProgress) => void;
}

const fmtNum = (n: number) => n.toLocaleString(i18n.language);

/** Định danh Postgres trong câu lệnh sinh ra: luôn bọc nháy kép, nhân đôi nháy kép bên trong. */
function quotePgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Lệnh cấp phiên mở đầu tệp dump.
 *
 * `restore_backup` bên trong app vốn đã tự lo mã hoá và khoá ngoại, nên những dòng này KHÔNG
 * phải để phục vụ nút Nhập — chúng để tệp còn chạy được bằng `mysql < dump.sql`, `psql -f`
 * hay `sqlite3 <` ở ngoài. Ở đó không có ai tắt kiểm tra khoá ngoại hộ, mà bảng thì xuất theo
 * thứ tự alphabet, nên `city` tham chiếu `country` là vỡ ngay.
 *
 * Bộ lọc theo bảng của `restore_backup` cho `SET …` và `PRAGMA …` luôn chạy và coi lỗi của
 * chúng là không nghiêm trọng (`is_session_level_stmt`), nên dump của dialect khác cũng không
 * chết vì mấy dòng này.
 *
 * `schema` (chỉ Postgres, chỉ khi khác `public`): tệp xuất từ schema `sales` mà nhập lại không
 * có hai dòng này thì mọi đối tượng chui vào schema đầu `search_path` của máy đích — thường là
 * `public` — tức là **nhập nhầm chỗ mà không báo lỗi gì**. Ghi ở header thay vì qualify từng
 * câu DDL là cố ý: tên trần cộng `search_path` thì người dùng đổi được schema đích chỉ bằng cách
 * sửa một dòng, còn tên đã qualify thì phải sửa cả tệp. `CREATE SCHEMA IF NOT EXISTS` đi kèm vì
 * `SET search_path` tới một schema chưa có là hợp lệ nhưng vô nghĩa — `CREATE TABLE` ngay sau đó
 * sẽ lỗi. Cả hai đều nằm trong danh sách "lệnh cấp phiên" của `restore_backup`
 * (`is_session_level_stmt`) nên luôn chạy dù người dùng chỉ chọn vài bảng.
 */
function dumpHeader(dbType: string, schema?: string | null): string[] {
  if (dbType === 'mysql') {
    return [
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      // Không có dòng này thì giá trị 0 trong cột AUTO_INCREMENT bị coi là "tự sinh đi" và
      // database nhập lại đánh số khác hẳn bản gốc. mysqldump cũng đặt đúng cờ này.
      "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
      '',
    ];
  }
  if (dbType === 'postgres') {
    const sch = (schema || '').trim();
    return [
      "SET client_encoding = 'UTF8';",
      // Literal nhị phân được ghi dạng '\xAB12'::bytea — tắt cờ này thì dấu \ thành ký tự
      // escape và mọi BLOB nhập lại sai nội dung.
      'SET standard_conforming_strings = on;',
      // `public` không ghi ra: đó đã là mặc định của mọi search_path, và bỏ qua giữ cho tệp
      // xuất từ database thường không khác gì bản trước khi có tính năng schema.
      ...(sch && sch !== 'public'
        ? [
            `CREATE SCHEMA IF NOT EXISTS ${quotePgIdent(sch)};`,
            `SET search_path TO ${quotePgIdent(sch)};`,
          ]
        : []),
      '',
    ];
  }
  // SQLite: bên trong một transaction thì PRAGMA này là no-op (SQLite quy định vậy), nên nó
  // chỉ có tác dụng khi chạy tệp bằng sqlite3 CLI — đúng chỗ cần.
  return ['PRAGMA foreign_keys = OFF;', ''];
}

/** Trả lại trạng thái phiên sau khi nạp xong. */
function dumpFooter(dbType: string): string[] {
  if (dbType === 'mysql') return ['SET FOREIGN_KEY_CHECKS = 1;'];
  if (dbType === 'postgres') return [];
  return ['PRAGMA foreign_keys = ON;'];
}

/**
 * Đọc hết dòng của một bảng theo trang.
 *
 * Tiến độ: mức ngoài là số bảng đã xong (cộng phần trăm của bảng đang chạy), dòng phụ là %
 * dòng trong bảng đó. Đọc theo trang chứ không một phát: trước đây giới hạn 100.000 dòng nên
 * bảng lớn bị xuất thiếu mà không báo gì.
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
 * Thứ tự các câu lệnh là thứ có ý nghĩa nhất ở đây — **bảng -> view -> routine -> trigger**:
 *   - `CREATE VIEW` được kiểm tra ngay lúc chạy, nên view đứng trước bảng mà nó SELECT là lỗi
 *     luôn (MySQL 1146). Danh sách đối tượng theo alphabet nên view `actor_info` của sakila
 *     từng đứng thứ hai, trước cả bảng `film`.
 *   - Giữa các view lại xếp theo phụ thuộc (`orderViewsByDependency`) vì view đọc được view khác.
 *   - Routine và trigger đứng cuối: thân chúng đọc bảng, và trigger còn có thể gọi hàm.
 * View KHÔNG xuất dữ liệu: `INSERT INTO <view>` lỗi khi view không updatable, và những dòng đó
 * vốn đã nằm trong các bảng gốc rồi.
 */
export async function buildDump(spec: DumpSpec, reader: DumpReader): Promise<string> {
  const { onProgress, sqlOptions } = spec;
  const isMysql = spec.dbType === 'mysql';
  const isPostgres = spec.dbType === 'postgres';
  const q = isMysql ? '`' : '"';

  // Routine/trigger không có dữ liệu, chỉ có định nghĩa -> tắt "kèm cấu trúc" là chúng không
  // còn gì để xuất. Cộng vào tổng để thanh tiến độ không dừng ở 100% rồi vẫn chạy tiếp.
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

  // ALTER TABLE ... ADD CONSTRAINT gom lại, ghi sau khi mọi bảng đã tồn tại (xem chỗ push).
  const deferredConstraints: string[] = [];
  // setval() của sequence: phải chạy sau khi dữ liệu đã vào, vì nó đọc MAX() của bảng.
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

    // Những thứ đi kèm bảng mà CREATE TABLE của dialect không chứa (index, FK, comment,
    // sequence). MySQL trả về rỗng vì SHOW CREATE TABLE đã gói sẵn tất cả.
    const extras = sqlOptions.includeStructure
      ? await reader.getTableDdlExtras(table)
      : { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
    // Khoá ngoại phải đợi TẤT CẢ bảng được tạo xong mới thêm được — bảng xuất theo thứ tự
    // alphabet, nên `city` tham chiếu `country` sẽ lỗi nếu gắn FK ngay tại chỗ.
    deferredConstraints.push(...extras.constraints);

    if (sqlOptions.dropTable) {
      parts.push(`DROP TABLE IF EXISTS ${q}${table}${q};`);
    }
    if (sqlOptions.includeStructure) {
      const def = await reader.getTableDefinition(table);
      if (def.success && def.sql) {
        parts.push(`-- Structure for table ${q}${table}${q}`);
        // Sequence đứng TRƯỚC bảng: cột serial có DEFAULT nextval('...') và Postgres kiểm tra
        // ngay lúc CREATE TABLE, thiếu sequence là restore chết ở bảng đầu tiên.
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
        // Cột GENERATED/IDENTITY bị loại khỏi INSERT: database tự tính chúng, ghi vào là lỗi
        // (MySQL 3105, Postgres đòi OVERRIDING SYSTEM VALUE) và cả lần nhập bị rollback.
        const colNames = schemaCols.filter((c) => !c.generated).map((c) => c.name);
        const cols = colNames.length ? colNames : Object.keys(rows[0]);
        // Ô nhị phân về đây là mảng byte; không đánh dấu thì nó bị JSON.stringify thành
        // '[137,80,78,71,...]' và tệp gốc coi như mất.
        const binaryCols = new Set(
          schemaCols.filter((c) => isBinaryType(c.type, spec.dbType)).map((c) => c.name)
        );
        // Cột identity thì NGƯỢC LẠI với generated: giữ trong INSERT để không mất id gốc,
        // nhưng câu lệnh phải xin phép ghi đè.
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

  // Khoá ngoại và các ràng buộc mức bảng khác: chỉ gắn được khi MỌI bảng đã tồn tại.
  if (deferredConstraints.length > 0) {
    parts.push('-- Constraints');
    parts.push(...deferredConstraints);
    parts.push('');
  }
  // setval() đọc MAX() của dữ liệu vừa nạp -> phải sau toàn bộ INSERT. Thiếu nó thì sequence
  // quay về 1 và dòng chèn tiếp theo đụng khoá chính.
  if (deferredSequenceValues.length > 0) {
    parts.push('-- Sequence values');
    parts.push(...deferredSequenceValues);
    parts.push('');
  }

  // View: chỉ định nghĩa. Tắt "kèm cấu trúc" thì view không còn gì để xuất, và lệnh DROP của
  // nó cũng phải im theo — DROP VIEW mà không có CREATE VIEW là xoá trắng.
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
        // Materialized view cần đúng chữ MATERIALIZED trong lệnh DROP; nhận biết từ chính DDL
        // vừa lấy về, khỏi phải kéo thêm một trường "loại" xuyên qua cả chuỗi gọi.
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
        // Postgres không cần DROP: pg_get_functiondef() trả về CREATE OR REPLACE FUNCTION, và
        // DROP FUNCTION ở đây thì phải kèm chữ ký tham số mới xoá đúng bản nạp chồng.
        if (sqlOptions.dropTable && isMysql) {
          const kw = routine.kind === 'function' ? 'FUNCTION' : 'PROCEDURE';
          drops.push(`DROP ${kw} IF EXISTS ${q}${routine.name}${q};`);
        }
        // pg_get_functiondef() trả về định nghĩa KHÔNG có dấu ';' ở cuối, khác SHOW CREATE của
        // MySQL — thiếu thì câu sau bị dính vào làm một. Bọc DELIMITER sẽ tự bỏ dấu này.
        const sql = stripDefiner(def.sql.trim());
        creates.push(sql.endsWith(';') ? sql : sql + ';');
      } else {
        parts.push(schemaFailed(routine.name, def.error));
      }
      reportStep(routine.name, true);
      step++;
    }

    // Event chỉ có ở MySQL, và thân nó (`DO BEGIN ... END`) cũng chứa dấu ';' như routine nên
    // đi chung khối DELIMITER phía dưới.
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

    // Câu CREATE TRIGGER lấy một lần cho cả database (get_all_triggers); Postgres còn cần tên
    // bảng chủ vì DROP TRIGGER của nó bắt buộc có `ON <table>`.
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
      // MySQL: thân routine/trigger có dấu ';' riêng nên phải đổi delimiter, nếu không bộ tách
      // cắt ngay giữa thân. Postgres dùng $$ (cả hai bộ tách đều hiểu), SQLite thì khối
      // BEGIN...END được chính bộ tách nhận diện.
      parts.push(...(isMysql ? wrapMysqlDelimiter(creates) : creates));
      parts.push('');
    }
  }

  parts.push(...dumpFooter(spec.dbType));
  return parts.join('\n');
}
