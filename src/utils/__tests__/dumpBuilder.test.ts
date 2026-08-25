import { describe, it, expect } from 'vitest';
import { buildDump, type DumpReader, type DumpSpec } from '../dumpBuilder';
import { parseDumpObjects, parseDumpTableNames } from '../dumpPreview';
import { splitStatements } from '../../sql/statements';

// Reader giả: đủ to build dump mà not cần backend. Đây chính is lý do buildDump receive reader
// qua tham số thay vì import dbHelper — thứ tự statement mới kiểm chứng is bằng test.
function fakeReader(over: Partial<DumpReader> = {}): DumpReader {
  return {
    getTableDefinition: async (name) => ({ success: true, sql: `CREATE TABLE \`${name}\` (id int)` }),
    getTableSchema: async () => ({ columns: [{ name: 'id' } as any], indexes: [], foreignKeys: [] }),
    getTableData: async () => ({ rows: [{ id: 1 }], totalCount: 1 }),
    getObjectDefinition: async (name, kind) => ({
      success: true,
      sql:
        kind === 'function'
          ? `CREATE DEFINER=\`root\`@\`localhost\` FUNCTION \`${name}\`() RETURNS int RETURN 1`
          : `CREATE DEFINER=\`root\`@\`localhost\` PROCEDURE \`${name}\`() BEGIN SELECT 1; END`,
    }),
    getTableDdlExtras: async () => ({
      sequences: [],
      indexes: [],
      constraints: [],
      comments: [],
      sequenceValues: [],
    }),
    getAllTriggers: async () => [
      {
        name: 'ins_film',
        table: 'film',
        statement: 'CREATE TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN SET @a = 1; END',
      },
    ],
    ...over,
  };
}

const spec = (over: Partial<DumpSpec> = {}): DumpSpec => ({
  dbType: 'mysql',
  tables: ['actor_info', 'film'],
  views: ['actor_info'],
  routines: [{ name: 'get_balance', kind: 'function' }, { name: 'film_in_stock', kind: 'procedure' }],
  triggers: ['ins_film'],
  sqlOptions: { dropTable: true, includeStructure: true, includeContent: true },
  ...over,
});

/** position xuất hiện đầu tiên of một string in dump (-1 if not có). */
const at = (dump: string, needle: string) => dump.indexOf(needle);

describe('buildDump — thứ tự câu lệnh', () => {
  it('bảng -> view -> routine -> trigger, dù danh sách vào theo alphabet', async () => {
    // `actor_info` is view and đứng TRƯỚC table `film` mà nó read — đúng tình huống ism hỏng
    // lần nhập lại of sakila (MySQL 1146).
    const dump = await buildDump(spec(), fakeReader());

    expect(at(dump, 'CREATE TABLE `film`')).toBeGreaterThan(-1);
    expect(at(dump, 'CREATE TABLE `film`')).toBeLessThan(at(dump, '-- Structure for view `actor_info`'));
    expect(at(dump, '-- Structure for view `actor_info`')).toBeLessThan(at(dump, '-- Routines and triggers'));
    expect(at(dump, 'FUNCTION `get_balance`')).toBeLessThan(at(dump, 'TRIGGER `ins_film`'));
  });

  it('view không xuất dữ liệu, bảng thì có', async () => {
    const dump = await buildDump(spec(), fakeReader());
    expect(dump).toContain('INSERT INTO `film`');
    expect(dump).not.toContain('INSERT INTO `actor_info`');
  });

  it('bỏ "kèm cấu trúc" thì không còn view/routine/trigger, và cũng không có DROP mồ côi', async () => {
    const dump = await buildDump(
      spec({ sqlOptions: { dropTable: true, includeStructure: false, includeContent: true } }),
      fakeReader()
    );
    expect(dump).not.toContain('CREATE');
    expect(dump).not.toContain('DROP VIEW');
    expect(dump).not.toContain('DROP TRIGGER');
    expect(dump).toContain('INSERT INTO `film`');
  });
});

// Header/footer not must to phục vụ nút Nhập of app (restore_backup tự lo mã hoá and key
// ngoại) mà to tệp run is bằng `mysql <` / `psql -f` / `sqlite3 <` at ngoài.
describe('buildDump — header/footer cấp phiên', () => {
  const bare = (dbType: string) =>
    spec({ dbType, tables: ['film'], views: [], routines: [], triggers: [] });

  it('MySQL: tắt kiểm tra khoá ngoại ở đầu và bật lại ở cuối', async () => {
    const dump = await buildDump(bare('mysql'), fakeReader());
    expect(dump).toContain('SET NAMES utf8mb4;');
    expect(dump).toContain('SET FOREIGN_KEY_CHECKS = 0;');
    expect(dump).toContain("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';");
    // Bật lại must is row CUỐI, sau toàn bộ dữ liệu.
    expect(dump.trimEnd().endsWith('SET FOREIGN_KEY_CHECKS = 1;')).toBe(true);
    expect(at(dump, 'SET FOREIGN_KEY_CHECKS = 0;')).toBeLessThan(at(dump, 'CREATE TABLE'));
  });

  it('Postgres: khai báo standard_conforming_strings (literal bytea phụ thuộc vào nó)', async () => {
    const dump = await buildDump(bare('postgres'), fakeReader());
    expect(dump).toContain("SET client_encoding = 'UTF8';");
    expect(dump).toContain('SET standard_conforming_strings = on;');
    // Postgres not cần tắt foreign key: FK already is dời xuống cuối bằng ADD CONSTRAINT.
    expect(dump).not.toContain('FOREIGN_KEY_CHECKS');
  });

  it('SQLite: PRAGMA foreign_keys OFF/ON bọc hai đầu', async () => {
    const dump = await buildDump(bare('sqlite'), fakeReader());
    expect(at(dump, 'PRAGMA foreign_keys = OFF;')).toBeLessThan(at(dump, 'CREATE TABLE'));
    expect(dump.trimEnd().endsWith('PRAGMA foreign_keys = ON;')).toBe(true);
  });

  it('Postgres: schema khác public thì header tạo schema rồi đặt search_path', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'sales' }, fakeReader());
    expect(dump).toContain('CREATE SCHEMA IF NOT EXISTS "sales";');
    expect(dump).toContain('SET search_path TO "sales";');
    // must đứng trước mọi DDL, if not thì table đầu tiên already rơi ando schema khác rồi.
    expect(at(dump, 'SET search_path TO "sales";')).toBeLessThan(at(dump, 'CREATE TABLE'));
    // and CREATE SCHEMA must trước SET, vì đặt search_path tới schema chưa có is vô nghĩa.
    expect(at(dump, 'CREATE SCHEMA IF NOT EXISTS "sales";'))
      .toBeLessThan(at(dump, 'SET search_path TO "sales";'));
  });

  it('Postgres: public (hoặc không truyền) không thêm dòng nào — dump giữ nguyên như cũ', async () => {
    for (const schema of [undefined, null, 'public', '  ']) {
      const dump = await buildDump({ ...bare('postgres'), schema }, fakeReader());
      expect(dump).not.toContain('CREATE SCHEMA');
      expect(dump).not.toContain('search_path');
    }
  });

  it('MySQL/SQLite bỏ qua schema: cả hai không có khái niệm này', async () => {
    for (const dbType of ['mysql', 'sqlite']) {
      const dump = await buildDump({ ...bare(dbType), schema: 'sales' }, fakeReader());
      expect(dump).not.toContain('CREATE SCHEMA');
      expect(dump).not.toContain('search_path');
    }
  });

  it('tên schema có dấu nháy kép vẫn ra định danh hợp lệ', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'we"ird' }, fakeReader());
    expect(dump).toContain('CREATE SCHEMA IF NOT EXISTS "we""ird";');
    expect(dump).toContain('SET search_path TO "we""ird";');
  });

  it('hai dòng schema là câu lệnh riêng, và restore_backup luôn chạy chúng', async () => {
    const dump = await buildDump({ ...bare('postgres'), schema: 'sales' }, fakeReader());
    const stmts = splitStatements(dump).map((s) => s.text);
    expect(stmts).toContain('CREATE SCHEMA IF NOT EXISTS "sales"');
    expect(stmts).toContain('SET search_path TO "sales"');
    // Twin of `is_session_level_stmt` (database.rs): lệnh nào open đầu bằng SET / CREATE SCHEMA
    // đều is for run dù user chỉ select andi table. Hai row này not nhắc tên table nào,
    // nên if viết khác đi is chúng is bộ filter theo table loại bỏ and dump nhập ando nhầm schema.
    for (const s of ['CREATE SCHEMA IF NOT EXISTS "sales"', 'SET search_path TO "sales"']) {
      expect(/^(SET |CREATE SCHEMA)/.test(s.toUpperCase())).toBe(true);
    }
  });

  it('header là câu lệnh hợp lệ, không lẫn vào câu lệnh đầu tiên', async () => {
    const dump = await buildDump(bare('mysql'), fakeReader());
    const stmts = splitStatements(dump).map((s) => s.text);
    // Câu đầu còn dính hai row comment open đầu tệp — đúng như bộ tách vẫn ism (bên Rust có
    // `strip_leading_comments`), miễn is mỗi lệnh SET vẫn is một câu riêng.
    expect(stmts[0].endsWith('SET NAMES utf8mb4')).toBe(true);
    expect(stmts[1]).toBe('SET FOREIGN_KEY_CHECKS = 0');
    expect(stmts[2]).toBe("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'");
  });
});

describe('buildDump — theo dialect', () => {
  it('MySQL bọc routine/trigger trong DELIMITER và bỏ DEFINER', async () => {
    const dump = await buildDump(spec(), fakeReader());
    expect(dump).toContain('DELIMITER $$');
    expect(dump).toContain('DELIMITER ;');
    expect(dump).not.toContain('DEFINER=');
    // Bộ tách read lại must ra ĐÚNG một câu for procedure (thân có dấu ';' riêng).
    const stmts = splitStatements(dump).map((s) => s.text);
    const proc = stmts.filter((s) => s.includes('PROCEDURE `film_in_stock`'));
    expect(proc).toHaveLength(1);
    expect(proc[0]).toContain('SELECT 1;');
  });

  it('Postgres: không DROP FUNCTION, DROP TRIGGER có kèm ON <table>, không có DELIMITER', async () => {
    const dump = await buildDump(
      spec({
        dbType: 'postgres',
        tables: ['film'],
        views: [],
        routines: [{ name: 'f', kind: 'function' }],
        triggers: ['trg'],
      }),
      fakeReader({
        getObjectDefinition: async (name) => ({
          success: true,
          sql: `CREATE OR REPLACE FUNCTION "${name}"() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql`,
        }),
        getAllTriggers: async () => [
          { name: 'trg', table: 'film', statement: 'CREATE TRIGGER trg AFTER INSERT ON film EXECUTE FUNCTION f()' },
        ],
      })
    );
    expect(dump).not.toContain('DELIMITER');
    expect(dump).not.toContain('DROP FUNCTION');
    expect(dump).toContain('DROP TRIGGER IF EXISTS "trg" ON "film";');
    expect(dump).not.toContain('DROP VIEW'); // not select view nào -> not is có DROP VIEW
  });

  it('SQLite: trigger BEGIN...END vẫn đọc lại được thành một câu', async () => {
    const dump = await buildDump(
      spec({ dbType: 'sqlite', tables: ['film'], views: [], routines: [], triggers: ['trg'] }),
      fakeReader({
        getTableDefinition: async (name) => ({ success: true, sql: `CREATE TABLE "${name}" (id integer)` }),
        getAllTriggers: async () => [
          {
            name: 'trg',
            table: 'film',
            statement: 'CREATE TRIGGER trg AFTER INSERT ON film BEGIN UPDATE stat SET n = n + 1; END',
          },
        ],
      })
    );
    const trg = splitStatements(dump).map((s) => s.text).filter((s) => s.includes('CREATE TRIGGER'));
    expect(trg).toHaveLength(1);
    expect(trg[0]).toContain('UPDATE stat SET n = n + 1;');
  });
});

// Những thứ đi kèm table nhưng not nằm in CREATE TABLE of dialect (index of SQLite,
// index/FK/comment/sequence of Postgres). position đặt chúng mới is phần dễ sai.
describe('buildDump — phần đi kèm bảng', () => {
  const extrasReader = (over: Record<string, string[]> = {}) =>
    fakeReader({
      getTableDdlExtras: async (table) => ({
        sequences: [`CREATE SEQUENCE IF NOT EXISTS ${table}_id_seq;`],
        indexes: [`CREATE INDEX idx_${table}_a ON ${table} (a);`],
        constraints: [`ALTER TABLE ${table} ADD CONSTRAINT fk_${table} FOREIGN KEY (b) REFERENCES other (id);`],
        comments: [`COMMENT ON TABLE ${table} IS 'x';`],
        sequenceValues: [`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 1), true);`],
        ...over,
      }),
    });

  it('sequence trước CREATE TABLE, index/comment ngay sau, FK sau MỌI bảng, setval sau dữ liệu', async () => {
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['a_tbl', 'z_tbl'], views: [], routines: [], triggers: [] }),
      extrasReader()
    );
    expect(at(dump, 'CREATE SEQUENCE IF NOT EXISTS a_tbl_id_seq;')).toBeLessThan(at(dump, 'CREATE TABLE `a_tbl`'));
    expect(at(dump, 'CREATE TABLE `a_tbl`')).toBeLessThan(at(dump, 'CREATE INDEX idx_a_tbl_a'));
    expect(at(dump, 'CREATE INDEX idx_a_tbl_a')).toBeLessThan(at(dump, 'COMMENT ON TABLE a_tbl'));
    // FK of table ĐẦU must nằm sau CREATE TABLE of table CUỐI, if not thì table is tham
    // chiếu chưa tồn tại lúc gắn foreign key.
    expect(at(dump, 'CREATE TABLE `z_tbl`')).toBeLessThan(at(dump, 'ADD CONSTRAINT fk_a_tbl'));
    // setval read MAX() nên must sau INSERT.
    expect(at(dump, 'INSERT INTO `z_tbl`')).toBeLessThan(at(dump, "setval('a_tbl_id_seq'"));
  });

  it('tắt "kèm cấu trúc" thì không hỏi phần đi kèm và không sinh câu nào', async () => {
    let called = 0;
    const dump = await buildDump(
      spec({
        tables: ['film'],
        views: [],
        routines: [],
        triggers: [],
        sqlOptions: { dropTable: false, includeStructure: false, includeContent: true },
      }),
      fakeReader({
        getTableDdlExtras: async () => {
          called++;
          return { sequences: [], indexes: [], constraints: [], comments: [], sequenceValues: [] };
        },
      })
    );
    expect(called).toBe(0);
    expect(dump).not.toContain('-- Constraints');
    expect(dump).not.toContain('-- Sequence values');
  });

  it('MySQL/SQLite không có phần nào thì dump không thừa tiêu đề rỗng', async () => {
    const dump = await buildDump(spec({ triggers: [] }), fakeReader());
    expect(dump).not.toContain('-- Constraints');
    expect(dump).not.toContain('-- Sequence values');
  });
});

describe('buildDump — dữ liệu trung thực', () => {
  it('cột generated không nằm trong INSERT', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [
            { name: 'id' },
            { name: 'title' },
            // MySQL 3105 if write ando column này.
            { name: 'title_upper', generated: true },
          ] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 1, title: 'a', title_upper: 'A' }], totalCount: 1 }),
      })
    );
    expect(dump).toContain('INSERT INTO `film` (`id`, `title`)');
    expect(dump).not.toContain('title_upper');
  });

  it('cột identity vẫn nằm trong INSERT, kèm OVERRIDING SYSTEM VALUE', async () => {
    // Bỏ column identity đi thì Postgres tự đánh số lại -> mọi foreign key trỏ tới table này lệch.
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [{ name: 'id', identityAlways: true }, { name: 'title' }] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 7, title: 'a' }], totalCount: 1 }),
      })
    );
    expect(dump).toContain('INSERT INTO "film" ("id", "title") OVERRIDING SYSTEM VALUE VALUES');
    expect(dump).toContain('(7, \'a\')');
  });

  it('cột BLOB ra literal hex chứ không phải mảng số', async () => {
    const dump = await buildDump(
      spec({ tables: ['file'], views: [], routines: [], triggers: [] }),
      fakeReader({
        getTableSchema: async () => ({
          columns: [{ name: 'id', type: 'int' }, { name: 'data', type: 'longblob' }] as any,
          indexes: [],
          foreignKeys: [],
        }),
        getTableData: async () => ({ rows: [{ id: 1, data: [137, 80, 78, 71] }], totalCount: 1 }),
      })
    );
    expect(dump).toContain("X'89504e47'");
    expect(dump).not.toContain('[137,80,78,71]');
  });
});

describe('buildDump — event và materialized view', () => {
  it('MySQL event nằm chung khối DELIMITER với routine, có DROP EVENT', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [], events: ['nightly_purge'] }),
      fakeReader({
        getObjectDefinition: async (name, kind) => ({
          success: true,
          sql:
            kind === 'event'
              ? `CREATE DEFINER=\`root\`@\`localhost\` EVENT \`${name}\` ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM log; END`
              : 'CREATE FUNCTION f() RETURNS int RETURN 1',
        }),
      })
    );
    expect(dump).toContain('DROP EVENT IF EXISTS `nightly_purge`;');
    expect(dump).toContain('DELIMITER $$');
    expect(dump).not.toContain('DEFINER=');
    // Thân event có ';' riêng -> bộ tách must read lại ra đúng MỘT câu.
    const evt = splitStatements(dump).map((s) => s.text).filter((s) => s.includes('EVENT `nightly_purge`'));
    expect(evt).toHaveLength(1);
    expect(evt[0]).toContain('DELETE FROM log;');
  });

  it('materialized view dùng DROP MATERIALIZED VIEW, không phải DROP VIEW', async () => {
    const dump = await buildDump(
      spec({ dbType: 'postgres', tables: ['mv_stats'], views: ['mv_stats'], routines: [], triggers: [] }),
      fakeReader({
        getTableDefinition: async (name) => ({
          success: true,
          sql: `CREATE MATERIALIZED VIEW "${name}" AS\n SELECT 1;`,
        }),
      })
    );
    expect(dump).toContain('DROP MATERIALIZED VIEW IF EXISTS "mv_stats" CASCADE;');
    expect(dump).not.toContain('DROP VIEW IF EXISTS');
    // Matview đứng sau table nên CREATE ... WITH DATA (default) already có sẵn dữ liệu to read.
    expect(dump).toContain('CREATE MATERIALIZED VIEW "mv_stats"');
  });
});

describe('buildDump — đọc lại được bằng chính bộ dò của popup Nhập', () => {
  it('parseDumpObjects nhận ra đủ bảng/view/routine/trigger', async () => {
    const dump = await buildDump(spec(), fakeReader());
    const objs = parseDumpObjects(dump);
    // Reader giả trả `CREATE TABLE` for cả view, nên at đây view nằm in `tables` — điều is
    // kiểm chứng is mọi đối tượng đều scan lại is, not must cách categorize of reader.
    expect(objs.tables).toEqual(['film', 'actor_info']);
    expect(objs.views).toEqual([]);
    expect(objs.functions).toEqual(['get_balance']);
    expect(objs.procedures).toEqual(['film_in_stock']);
    expect(objs.triggers).toEqual(['ins_film']);
  });

  it('header schema không bị nhận nhầm thành một bảng để chọn', async () => {
    // `parseDumpTableNames` vừa build danh sách for user tick, vừa is bộ filter send xuống
    // `restore_backup`. Một mục "sales" ma in đó vừa khó hiểu, vừa ism statement of table
    // thật is bỏ when user chỉ select nó.
    const dump = await buildDump(
      { ...spec({ dbType: 'postgres', tables: ['film'], views: [], routines: [], triggers: [] }), schema: 'sales' },
      fakeReader()
    );
    expect(dump).toContain('SET search_path TO "sales";');
    expect(parseDumpTableNames(dump)).toEqual(['film']);
  });
});

describe('buildDump — lỗi đọc định nghĩa', () => {
  it('ghi chú thích lỗi thay vì làm hỏng cả lần xuất', async () => {
    const dump = await buildDump(
      spec({ tables: ['film'], views: [], routines: [], triggers: [] }),
      fakeReader({ getTableDefinition: async () => ({ success: false, error: 'boom' }) })
    );
    expect(dump).toContain('boom');
    expect(dump).toContain('INSERT INTO `film`');
  });
});
