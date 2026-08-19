import { describe, expect, it } from 'vitest';
import { splitStatements, statementAt, analyzeStatements, resolveAliases, collectTableRefs, collectCteNames, describeStatement, enclosingCall, valuePosition, isSchemaChangingSql, findUnsafeStatements } from '../../sql/statements';
import { formatSql, minifySql } from '../../sql/format';

describe('splitStatements', () => {
  it('tách nhiều câu lệnh theo dấu ;', () => {
    const sql = 'SELECT 1;\nSELECT 2;';
    expect(splitStatements(sql).map(s => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it("bỏ qua dấu ; nằm trong chuỗi", () => {
    const sql = "SELECT * FROM t WHERE note = 'a;b'";
    expect(splitStatements(sql).map(s => s.text)).toEqual([sql]);
  });

  it('bỏ qua dấu ; trong comment dòng và comment khối', () => {
    const sql = 'SELECT 1 -- chú thích; vẫn cùng câu\n/* khối ; */ + 2';
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it('bỏ đoạn trống và đoạn chỉ có comment', () => {
    const sql = 'SELECT 1;;\n-- chỉ là comment\n;SELECT 2;';
    expect(splitStatements(sql).map(s => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('offset trả về trỏ đúng vào văn bản gốc', () => {
    const sql = '  SELECT 1  ;  SELECT 2';
    const [first, second] = splitStatements(sql);
    expect(sql.slice(first.start, first.end)).toBe('SELECT 1');
    expect(sql.slice(second.start, second.end)).toBe('SELECT 2');
  });
});

describe('splitStatements — khối $$ của Postgres', () => {
  const fn = [
    'CREATE FUNCTION bump() RETURNS trigger AS $$',
    'BEGIN',
    "  UPDATE t SET n = n + 1 WHERE id = NEW.id;",
    '  RETURN NEW;',
    'END;',
    '$$ LANGUAGE plpgsql;',
    'SELECT 1;',
  ].join('\n');

  it("không cắt giữa thân function ($$ ... $$)", () => {
    const stmts = splitStatements(fn);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('CREATE FUNCTION');
    expect(stmts[0].text).toContain('LANGUAGE plpgsql');
    expect(stmts[1].text).toBe('SELECT 1');
  });

  it('con trỏ trong thân function trả về cả câu CREATE FUNCTION', () => {
    const at = fn.indexOf('RETURN NEW');
    expect(statementAt(fn, at)?.text).toContain('CREATE FUNCTION');
  });

  it('hỗ trợ dollar-quote có tag ($body$)', () => {
    const sql = 'CREATE FUNCTION f() AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql; SELECT 3;';
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[1].text).toBe('SELECT 3');
  });

  it('không nhầm $1 (bind param) hay ${x} (tham số truy vấn) là dollar-quote', () => {
    expect(splitStatements('SELECT * FROM t WHERE id = $1; SELECT 2;')).toHaveLength(2);
    expect(splitStatements('SELECT * FROM t WHERE id = ${uid}; SELECT 2;')).toHaveLength(2);
  });

  it("không nhầm '$$' nằm trong chuỗi là mở khối", () => {
    expect(splitStatements("SELECT '$$'; SELECT 2;")).toHaveLength(2);
  });
});

describe('splitStatements — lệnh DELIMITER của MySQL', () => {
  const trigger = [
    'SELECT 1;',
    'DELIMITER //',
    'CREATE TRIGGER after_order_insert AFTER INSERT ON orders',
    'FOR EACH ROW',
    'BEGIN',
    '  UPDATE stats SET total = total + 1;',
    "  INSERT INTO audit(msg) VALUES ('new order');",
    'END//',
    'DELIMITER ;',
    'SELECT 2;',
  ].join('\n');

  it('giữ nguyên thân trigger, không cắt ở dấu ; bên trong', () => {
    const stmts = splitStatements(trigger);
    expect(stmts.map(s => s.text.split('\n')[0])).toEqual([
      'SELECT 1',
      'CREATE TRIGGER after_order_insert AFTER INSERT ON orders',
      'SELECT 2',
    ]);
    const body = stmts[1].text;
    expect(body).toContain('UPDATE stats');
    expect(body).toContain('INSERT INTO audit');
    expect(body.endsWith('END')).toBe(true); // '//' không bị gửi kèm
  });

  it('không bao giờ trả chính dòng DELIMITER thành câu lệnh', () => {
    for (const s of splitStatements(trigger)) {
      expect(s.text.toUpperCase()).not.toContain('DELIMITER');
    }
  });

  it('con trỏ trong thân trigger trả về cả câu CREATE TRIGGER', () => {
    const at = trigger.indexOf('INSERT INTO audit');
    expect(statementAt(trigger, at)?.text).toContain('CREATE TRIGGER');
  });

  it("`DELIMITER ;` khôi phục lại dấu ';'", () => {
    const stmts = splitStatements(trigger);
    expect(stmts[stmts.length - 1].text).toBe('SELECT 2');
  });

  it('hỗ trợ DELIMITER ;; (kiểu mysqldump --routines)', () => {
    const sql = [
      'DELIMITER ;;',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END ;;',
      'DELIMITER ;',
      'SELECT 3;',
    ].join('\n');
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('CREATE PROCEDURE');
    expect(stmts[0].text).toContain('SELECT 2');
    expect(stmts[1].text).toBe('SELECT 3');
  });

  it("DELIMITER $$ không bị hiểu thành khối dollar-quote của Postgres", () => {
    const sql = [
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN UPDATE t SET a = 1; UPDATE t SET b = 2; END$$',
      'DELIMITER ;',
      'SELECT 9;',
    ].join('\n');
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('UPDATE t SET b = 2');
    expect(stmts[1].text).toBe('SELECT 9');
  });

  it('DELIMITER nằm trong chuỗi/comment thì không phải lệnh', () => {
    expect(splitStatements("SELECT 'x\nDELIMITER //\ny'; SELECT 2;")).toHaveLength(2);
    expect(splitStatements('/*\nDELIMITER //\n*/ SELECT 1; SELECT 2;')).toHaveLength(2);
  });

  it('không nhận DELIMITER khi không ở đầu dòng', () => {
    // 'SELECT 1 DELIMITER //' là SQL sai, nhưng tuyệt đối không được đổi dấu kết thúc câu
    expect(splitStatements('SELECT 1 DELIMITER //; SELECT 2;')).toHaveLength(2);
  });
});

// SQLite không có lệnh DELIMITER, nên thân trigger phải được nhận diện ngay ở bộ tách —
// nếu không, dump xuất ra có trigger sẽ không nhập lại được ("incomplete input").
describe('splitStatements — thân trigger BEGIN...END', () => {
  it('giữ nguyên một câu CREATE TRIGGER dù thân có nhiều dấu ;', () => {
    const sql = [
      'CREATE TRIGGER audit_ins AFTER INSERT ON film BEGIN',
      "  UPDATE stat SET n = n + 1;",
      "  INSERT INTO log VALUES ('added');",
      'END;',
      'SELECT 1;',
    ].join('\n');
    const stmts = splitStatements(sql).map((s) => s.text);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('BEGIN');
    expect(stmts[0]).toContain("INSERT INTO log VALUES ('added')");
    expect(stmts[0].trimEnd().endsWith('END')).toBe(true);
    expect(stmts[1]).toBe('SELECT 1');
  });

  it('trigger Postgres không có BEGIN thì kết thúc ngay ở dấu ; (không nuốt phần sau)', () => {
    const sql = [
      'CREATE TRIGGER t_upd AFTER UPDATE ON film FOR EACH ROW EXECUTE FUNCTION f();',
      'SELECT 2;',
    ].join('\n');
    expect(splitStatements(sql).map((s) => s.text)).toEqual([
      'CREATE TRIGGER t_upd AFTER UPDATE ON film FOR EACH ROW EXECUTE FUNCTION f()',
      'SELECT 2',
    ]);
  });

  it('trigger MySQL một lệnh (không BEGIN) cũng kết thúc bình thường', () => {
    const sql = 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET NEW.a = 1;\nSELECT 3;';
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('dạng có DEFINER và OR REPLACE vẫn được nhận là trigger', () => {
    const sql =
      'CREATE DEFINER=`root`@`localhost` TRIGGER `t` AFTER INSERT ON `x` FOR EACH ROW BEGIN SET @a = 1; END;\nSELECT 4;';
    const stmts = splitStatements(sql).map((s) => s.text);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('SET @a = 1;');
  });

  it('BEGIN trong chuỗi/comment không kích hoạt luật', () => {
    const sql = "CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW SELECT 'BEGIN';\nSELECT 5;";
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it('câu khác mở đầu bằng CREATE không bị ảnh hưởng', () => {
    const sql = 'CREATE TABLE t (a int);\nCREATE VIEW v AS SELECT 1;\nSELECT 6;';
    expect(splitStatements(sql)).toHaveLength(3);
  });

  it('END rồi comment rồi ; vẫn kết thúc đúng chỗ', () => {
    const sql = 'CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE y SET a = 1; END /* xong */;\nSELECT 7;';
    expect(splitStatements(sql)).toHaveLength(2);
  });
});

describe('resolveAliases', () => {
  it('lấy alias có/không có AS', () => {
    const m = resolveAliases('SELECT * FROM orders o JOIN users AS u ON u.id = o.user_id');
    expect(m.get('o')).toBe('orders');
    expect(m.get('u')).toBe('users');
    expect(m.get('orders')).toBe('orders');
  });

  it('bảng không alias vẫn tra được bằng chính tên nó', () => {
    const m = resolveAliases('SELECT * FROM customers WHERE id = 1');
    expect(m.get('customers')).toBe('customers');
  });

  it('không coi từ khoá đứng sau tên bảng là alias', () => {
    const m = resolveAliases('SELECT * FROM orders WHERE x = 1');
    expect(m.get('where')).toBeUndefined();
    const m2 = resolveAliases('SELECT * FROM a JOIN b ON a.id = b.id');
    expect(m2.get('on')).toBeUndefined();
  });

  it('bảng ngay sau một bảng không alias vẫn được nhận', () => {
    // Trước đây nhóm alias khớp rồi mới loại 'JOIN', nên con trỏ regex đã trượt qua và
    // 'b' bị bỏ hẳn — hover trên b.* không tra được bảng.
    const m = resolveAliases('SELECT * FROM a JOIN b ON a.id = b.id');
    expect(m.get('a')).toBe('a');
    expect(m.get('b')).toBe('b');
  });

  it('bỏ dấu bao quanh và tiền tố schema', () => {
    const m = resolveAliases('SELECT * FROM "public"."orders" o');
    expect(m.get('o')).toBe('orders');
  });
});

describe('collectTableRefs', () => {
  it('giữ đúng thứ tự xuất hiện (gợi ý JOIN cần biết bảng nào JOIN sau cùng)', () => {
    const refs = collectTableRefs('SELECT * FROM a JOIN b ON a.id = b.id JOIN c ON c.id = b.id');
    expect(refs.map(r => r.table)).toEqual(['a', 'b', 'c']);
  });

  it('tách được alias, và không nhận từ khoá làm alias', () => {
    const refs = collectTableRefs('SELECT * FROM orders o JOIN users AS u ON u.id = o.user_id');
    expect(refs).toEqual([
      { table: 'orders', alias: 'o' },
      { table: 'users', alias: 'u' },
    ]);
    expect(collectTableRefs('SELECT * FROM orders WHERE x = 1')[0].alias).toBeUndefined();
  });

  // Hai ca dưới đây là lý do hàm này tồn tại: parser ANTLR trả entity thiếu/rỗng khi câu
  // lệnh còn gõ dở (Postgres bỏ mất bảng vừa JOIN ở ca 1; MySQL trả 0 entity ở ca 2),
  // làm mất alias -> gợi ý cột rơi về "mọi bảng" và không gợi ý được điều kiện JOIN.
  it('câu JOIN chưa gõ điều kiện: vẫn thấy cả hai bảng', () => {
    const refs = collectTableRefs('SELECT * FROM city c\nJOIN address a on ');
    expect(refs).toEqual([
      { table: 'city', alias: 'c' },
      { table: 'address', alias: 'a' },
    ]);
  });

  it('caret ngay sau "alias.": vẫn giữ được alias để lọc cột đúng bảng', () => {
    const refs = collectTableRefs('SELECT * FROM city c\nJOIN address a on c.');
    expect(resolveAliases('SELECT * FROM city c\nJOIN address a on c.').get('c')).toBe('city');
    expect(refs.map(r => r.table)).toEqual(['city', 'address']);
  });

  it('bỏ dấu bao quanh và tiền tố schema', () => {
    expect(collectTableRefs('SELECT * FROM `sakila`.`city` AS c')).toEqual([
      { table: 'city', alias: 'c' },
    ]);
  });
});

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';

  it('lấy câu lệnh chứa con trỏ', () => {
    expect(statementAt(sql, 3)?.text).toBe('SELECT 1');
    expect(statementAt(sql, 12)?.text).toBe('SELECT 2');
    expect(statementAt(sql, sql.length)?.text).toBe('SELECT 3');
  });

  it('con trỏ ngay sau dấu ; thuộc câu lệnh kế tiếp', () => {
    const at = sql.indexOf(';') + 1; // ngay sau ';' đầu tiên
    expect(statementAt(sql, at)?.text).toBe('SELECT 2');
  });

  it('con trỏ ở đúng dấu ; vẫn thuộc câu lệnh trước đó', () => {
    expect(statementAt(sql, sql.indexOf(';'))?.text).toBe('SELECT 1');
  });

  it("không cắt sai khi ; nằm trong chuỗi", () => {
    const s = "SELECT * FROM t WHERE a = 'x;y' AND b = 1";
    expect(statementAt(s, s.length)?.text).toBe(s);
  });

  it('trả null khi con trỏ ở vùng trống / chỉ có comment', () => {
    expect(statementAt('   \n  ', 2)).toBeNull();
    expect(statementAt('-- chỉ comment', 5)).toBeNull();
  });
});

describe('analyzeStatements', () => {
  // Đường tô sáng câu lệnh dùng analyzeStatements (mask 1 lần) thay cho splitStatements + statementAt
  // -> phải cho cùng kết quả ở MỌI vị trí con trỏ.
  const samples = [
    'SELECT 1;\nSELECT 2;\nSELECT 3',
    "SELECT * FROM t WHERE a = 'x;y'; SELECT 2;",
    'SELECT 1;;\n-- chỉ comment\n;SELECT 2;   ',
    'CREATE FUNCTION f() AS $$ SELECT 1; SELECT 2; $$ LANGUAGE sql; SELECT 3;',
    'SELECT 1;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nSELECT 2;',
    '   ',
  ];

  it('trùng khớp splitStatements + statementAt ở mọi offset', () => {
    for (const sql of samples) {
      const expectedList = splitStatements(sql).map(s => s.text);
      for (let offset = 0; offset <= sql.length; offset++) {
        const got = analyzeStatements(sql, offset);
        expect(got.statements.map(s => s.text)).toEqual(expectedList);
        expect(got.current?.text ?? null).toBe(statementAt(sql, offset)?.text ?? null);
      }
    }
  });
});

describe('isSchemaChangingSql', () => {
  it('nhận DDL', () => {
    for (const sql of [
      'CREATE TABLE t (id int)',
      'alter table t add column x int',
      'DROP VIEW v',
      'TRUNCATE TABLE logs',
      'ALTER TABLE a RENAME TO b',
      "COMMENT ON COLUMN t.c IS 'x'",
    ]) expect(isSchemaChangingSql(sql)).toBe(true);
  });

  it('nhận câu đổi database/schema đang dùng', () => {
    expect(isSchemaChangingSql('USE other_db')).toBe(true);
    expect(isSchemaChangingSql('SET search_path TO reporting')).toBe(true);
  });

  it('không nhận câu đọc/ghi dữ liệu thường', () => {
    for (const sql of [
      'SELECT * FROM t',
      'INSERT INTO t (a) VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t WHERE id = 1',
      'SET NAMES utf8mb4',
    ]) expect(isSchemaChangingSql(sql)).toBe(false);
  });

  it('không nhận từ khoá nằm trong chuỗi hoặc comment', () => {
    expect(isSchemaChangingSql("SELECT 'DROP TABLE t' AS s")).toBe(false);
    expect(isSchemaChangingSql('SELECT 1 -- CREATE TABLE x')).toBe(false);
    expect(isSchemaChangingSql('SELECT 1 /* ALTER TABLE y */')).toBe(false);
  });
});

describe('formatSql', () => {
  it('viết hoa từ khoá và xuống dòng theo dialect', () => {
    const out = formatSql('select a,b from users where id=1', 'postgres');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('giữ được CTE lồng nhau (chỗ formatter regex cũ bị vỡ)', () => {
    const src = 'with recent as (select id from orders where total > 100) select * from recent join users u on u.id = recent.id';
    const out = formatSql(src, 'postgres');
    expect(out).toContain('WITH');
    expect(out).toContain('JOIN');
    // Không được mất mệnh đề nào
    expect(out.toLowerCase()).toContain('recent');
    expect(out.toLowerCase()).toContain('orders');
  });

  it('giữ nguyên placeholder tham số truy vấn', () => {
    for (const src of ['select * from t where id = :user_id', 'select * from t where id = ?', 'select * from t where id = %uid%', 'select * from t where id = ${uid}']) {
      const out = formatSql(src, 'mysql');
      const token = src.slice(src.indexOf('= ') + 2);
      expect(out).toContain(token);
    }
  });

  it('trả nguyên văn khi đang gõ dở / parser lỗi (không làm hỏng nội dung)', () => {
    // sql-formatter ném lỗi với ngoặc chưa đóng hoặc chuỗi chưa kết thúc
    for (const broken of ['SELECT * FROM (', "SELECT 'chưa đóng nháy"]) {
      expect(formatSql(broken, 'mysql')).toBe(broken);
    }
  });

  it('không đổi chuỗi rỗng', () => {
    expect(formatSql('   ')).toBe('   ');
  });
});

describe('minifySql', () => {
  it('nén về 1 dòng và bỏ comment', () => {
    const src = 'SELECT a,\n  b -- ghi chú\nFROM t /* khối */\nWHERE a = 1';
    expect(minifySql(src)).toBe('SELECT a, b FROM t WHERE a = 1');
  });

  it('giữ nguyên khoảng trắng bên trong chuỗi', () => {
    const src = "SELECT   'a   b' ,  c   FROM t";
    expect(minifySql(src)).toBe("SELECT 'a   b', c FROM t");
  });

  it('không phá chuỗi có -- hoặc /* bên trong', () => {
    const src = "SELECT 'a -- b', '/* c */'   FROM t";
    expect(minifySql(src)).toBe("SELECT 'a -- b', '/* c */' FROM t");
  });

  it("giữ escape nháy đơn ''", () => {
    const src = "SELECT   'it''s   ok'  FROM t";
    expect(minifySql(src)).toBe("SELECT 'it''s   ok' FROM t");
  });

  it('bỏ khoảng trắng thừa quanh dấu ngoặc và dấu phẩy', () => {
    expect(minifySql('SELECT COUNT( a , b )   FROM t')).toBe('SELECT COUNT(a, b) FROM t');
  });
});

describe('findUnsafeStatements', () => {
  const kinds = (sql: string) => findUnsafeStatements(sql).map(s => s.kind);

  it('cảnh báo DELETE không có WHERE', () => {
    expect(kinds('DELETE FROM users')).toEqual(['deleteNoWhere']);
  });

  it('bỏ qua DELETE có WHERE', () => {
    expect(kinds('DELETE FROM users WHERE id = 1')).toEqual([]);
  });

  it('cảnh báo UPDATE không có WHERE', () => {
    expect(kinds('UPDATE users SET active = 0')).toEqual(['updateNoWhere']);
  });

  it('bỏ qua UPDATE có WHERE', () => {
    expect(kinds('UPDATE users SET active = 0 WHERE id = 1')).toEqual([]);
  });

  // Cùng luật mask với DELETE: WHERE nằm trong chuỗi không cứu được câu lệnh.
  it('vẫn cảnh báo UPDATE khi WHERE chỉ nằm trong chuỗi', () => {
    expect(kinds("UPDATE users SET note = 'no WHERE here'")).toEqual(['updateNoWhere']);
  });

  it('cảnh báo TRUNCATE, có hay không có TABLE', () => {
    expect(kinds('TRUNCATE users')).toEqual(['truncate']);
    expect(kinds('TRUNCATE TABLE users')).toEqual(['truncate']);
  });

  it('gom nhiều câu lệnh nguy hiểm trong một script', () => {
    expect(kinds('UPDATE a SET x = 1; TRUNCATE b; DELETE FROM c WHERE id = 1; DROP TABLE d;'))
      .toEqual(['updateNoWhere', 'truncate', 'dropTable']);
  });

  it('cảnh báo DROP TABLE (kể cả IF EXISTS / TEMPORARY)', () => {
    expect(kinds('DROP TABLE users')).toEqual(['dropTable']);
    expect(kinds('DROP TABLE IF EXISTS users')).toEqual(['dropTable']);
    expect(kinds('DROP TEMPORARY TABLE t')).toEqual(['dropTable']);
  });

  it('không cảnh báo DROP VIEW/INDEX/DATABASE', () => {
    expect(kinds('DROP VIEW v; DROP INDEX i; DROP DATABASE d')).toEqual([]);
  });

  it('chỉ cảnh báo đúng câu vi phạm trong script nhiều câu lệnh', () => {
    const sql = 'DELETE FROM a WHERE id=1;\nDELETE FROM b;\nSELECT 1;\nDROP TABLE c;';
    expect(kinds(sql)).toEqual(['deleteNoWhere', 'dropTable']);
  });

  // WHERE nằm trong comment thì không chạy -> vẫn phải cảnh báo (hướng an toàn).
  it('không bị comment qua mặt', () => {
    expect(kinds('DELETE FROM t -- WHERE id = 1')).toEqual(['deleteNoWhere']);
    expect(kinds('DELETE FROM t /* WHERE id = 1 */')).toEqual(['deleteNoWhere']);
  });

  // Ngược lại: từ khoá nằm trong chuỗi/tên có nháy không được tính là câu lệnh thật.
  it('không báo nhầm khi DROP TABLE nằm trong chuỗi', () => {
    expect(kinds("DELETE FROM logs WHERE msg = 'drop table x'")).toEqual([]);
    expect(kinds("INSERT INTO t VALUES ('DELETE FROM u')")).toEqual([]);
  });

  it('cảnh báo dạng DELETE nhiều bảng của MySQL khi thiếu WHERE', () => {
    expect(kinds('DELETE a FROM a JOIN b ON a.id = b.id')).toEqual(['deleteNoWhere']);
  });

  it('trả về nguyên văn câu lệnh để hiện trong hộp cảnh báo', () => {
    expect(findUnsafeStatements('  DELETE FROM users  ;')[0].text).toBe('DELETE FROM users');
  });

  it('văn bản rỗng / chỉ có comment -> không có gì', () => {
    expect(kinds('')).toEqual([]);
    expect(kinds('-- DELETE FROM t')).toEqual([]);
  });
});

describe('valuePosition', () => {
  it('nhận ra chỗ điền giá trị sau toán tử so sánh', () => {
    expect(valuePosition('SELECT * FROM t WHERE status = '))
      .toEqual({ column: 'status', quoted: false });
    expect(valuePosition("SELECT * FROM t WHERE status = '"))
      .toEqual({ column: 'status', quoted: true });
    expect(valuePosition('SELECT * FROM t WHERE u.status <> '))
      .toEqual({ column: 'u.status', quoted: false });
    expect(valuePosition('SELECT * FROM t WHERE `status` = '))
      .toEqual({ column: 'status', quoted: false });
  });

  it('nhận ra IN (...) kể cả khi đã có giá trị liệt kê trước', () => {
    expect(valuePosition('WHERE status IN (')).toEqual({ column: 'status', quoted: false });
    expect(valuePosition("WHERE status IN ('a', ")).toEqual({ column: 'status', quoted: false });
    expect(valuePosition("WHERE status NOT IN ('a', '")).toEqual({ column: 'status', quoted: true });
  });

  it('nhận ra LIKE', () => {
    expect(valuePosition('WHERE name LIKE ')).toEqual({ column: 'name', quoted: false });
  });

  it('không nhận khi chưa tới chỗ điền giá trị', () => {
    expect(valuePosition('SELECT * FROM t WHERE status')).toBeNull();
    expect(valuePosition('SELECT * FROM t WHERE ')).toBeNull();
    expect(valuePosition("SELECT * FROM t WHERE status = 'a'")).toBeNull();
    expect(valuePosition('SELECT * FROM t WHERE 1 = ')).toBeNull(); // số không phải tên cột
  });
});

describe('describeStatement', () => {
  const label = (sql: string) => describeStatement(sql).label;

  it('DML lấy tên bảng chính', () => {
    expect(label('SELECT id, name FROM users WHERE id = 1')).toBe('SELECT users');
    expect(label('INSERT INTO orders (a) VALUES (1)')).toBe('INSERT orders');
    expect(label('UPDATE users SET name = 1')).toBe('UPDATE users');
    expect(label('DELETE FROM sessions WHERE id = 2')).toBe('DELETE sessions');
  });

  it('DDL lấy cả loại đối tượng lẫn tên, bỏ qua từ đệm', () => {
    expect(label('CREATE TABLE users (id INT)')).toBe('CREATE TABLE users');
    expect(label('CREATE TABLE IF NOT EXISTS users (id INT)')).toBe('CREATE TABLE users');
    expect(label('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe('CREATE VIEW v');
    expect(label('CREATE UNIQUE INDEX idx_a ON t (a)')).toBe('CREATE INDEX idx_a');
    expect(label('DROP TABLE `orders`')).toBe('DROP TABLE orders');
    expect(label('ALTER TABLE users ADD COLUMN x INT')).toBe('ALTER TABLE users');
  });

  it('CTE được gọi tên theo câu lệnh thật, không phải theo WITH', () => {
    expect(label('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent'))
      .toBe('SELECT orders');
  });

  it('động từ trong chuỗi, comment hay truy vấn con không cướp nhãn', () => {
    expect(label("SELECT 'DROP TABLE x' FROM users")).toBe('SELECT users');
    expect(label('-- DROP TABLE x\nSELECT * FROM users')).toBe('SELECT users');
    expect(label('SELECT (SELECT 1) FROM users')).toBe('SELECT users');
  });

  it('loại câu lệnh dùng để chọn biểu tượng', () => {
    expect(describeStatement('SELECT 1 FROM t').kind).toBe('select');
    expect(describeStatement('UPDATE t SET a = 1').kind).toBe('write');
    expect(describeStatement('CREATE TABLE t (a INT)').kind).toBe('ddl');
    expect(describeStatement('SET foreign_key_checks = 0').kind).toBe('other');
  });

  it('không nhận ra thì vẫn cho một nhãn định vị được, không bỏ trống', () => {
    expect(label('???')).toBe('???');
    expect(label('   ')).toBe('SQL');
  });
});

describe('enclosingCall', () => {
  // `|` đánh dấu con trỏ; ký tự đó bị bỏ ra trước khi gọi.
  const at = (marked: string) => {
    const offset = marked.indexOf('|');
    return enclosingCall(marked.replace('|', ''), offset);
  };

  it('nhận ra hàm và tham số đang gõ', () => {
    expect(at('SELECT date_add(|')).toEqual({ name: 'date_add', activeParam: 0 });
    expect(at('SELECT date_add(a, |')).toEqual({ name: 'date_add', activeParam: 1 });
    expect(at('SELECT date_add(a, b, c|)')).toEqual({ name: 'date_add', activeParam: 2 });
  });

  it('không đếm dấu phẩy của lời gọi lồng bên trong', () => {
    expect(at('SELECT concat(a, foo(b, c), |')).toEqual({ name: 'concat', activeParam: 2 });
  });

  it('bỏ qua ngoặc và phẩy nằm trong chuỗi hoặc comment', () => {
    expect(at("SELECT concat('a, (b', |")).toEqual({ name: 'concat', activeParam: 1 });
    expect(at('SELECT concat(a /* , ( */, |')).toEqual({ name: 'concat', activeParam: 1 });
  });

  it('ngoặc dùng để nhóm biểu thức không phải lời gọi hàm', () => {
    // `SELECT` có mục trong bộ tài liệu, nên nới lỏng chỗ này là mỗi lần mở ngoặc lại nhảy ra
    // bảng cú pháp của SELECT.
    expect(at('SELECT (a + |')).toBeNull();
    expect(at('SELECT count (|')).toBeNull();
  });

  it('không vượt qua dấu ; sang câu lệnh khác', () => {
    expect(at('SELECT foo(a); SELECT |')).toBeNull();
  });

  it('ngoài mọi lời gọi thì không trả về gì', () => {
    expect(at('SELECT a FROM t |')).toBeNull();
    expect(at('SELECT foo(a) |')).toBeNull();
  });
});

describe('collectCteNames', () => {
  const names = (sql: string) => [...collectCteNames(sql)].sort();

  it('lấy tên CTE đơn', () => {
    expect(names('WITH recent AS (SELECT * FROM orders) SELECT * FROM recent')).toEqual(['recent']);
  });

  it('lấy đủ danh sách CTE ngăn bằng dấu phẩy', () => {
    expect(names('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b ON 1=1'))
      .toEqual(['a', 'b']);
  });

  it('bỏ qua thân CTE có ngoặc lồng nhau', () => {
    const sql = 'WITH x AS (SELECT (SELECT 1) AS a FROM (SELECT 2) t), y AS (SELECT 3) SELECT * FROM y';
    expect(names(sql)).toEqual(['x', 'y']);
  });

  it('hiểu RECURSIVE, danh sách cột và MATERIALIZED', () => {
    expect(names('WITH RECURSIVE tree (id, parent) AS (SELECT 1, NULL) SELECT * FROM tree'))
      .toEqual(['tree']);
    expect(names('WITH t AS NOT MATERIALIZED (SELECT 1) SELECT * FROM t')).toEqual(['t']);
  });

  it('thấy cả CTE lồng trong thân một CTE khác', () => {
    expect(names('WITH outer_q AS (WITH inner_q AS (SELECT 1) SELECT * FROM inner_q) SELECT * FROM outer_q'))
      .toEqual(['inner_q', 'outer_q']);
  });

  it('WITH trong chuỗi hoặc comment không tính', () => {
    expect(names("SELECT 'WITH fake AS (SELECT 1)' FROM t")).toEqual([]);
    expect(names('-- WITH fake AS (SELECT 1)\nSELECT * FROM t')).toEqual([]);
  });

  it('không đoán bừa khi WITH không mở đầu một CTE', () => {
    expect(names('SELECT * FROM t WITH (NOLOCK)')).toEqual([]);
    expect(names('WITH')).toEqual([]);
  });

  it('tên được hạ về chữ thường để so khớp không phân biệt hoa thường', () => {
    expect(names('WITH Recent AS (SELECT 1) SELECT * FROM RECENT')).toEqual(['recent']);
  });
});
