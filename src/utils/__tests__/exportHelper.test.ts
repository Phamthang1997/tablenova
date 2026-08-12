import { describe, it, expect } from 'vitest';
import {
  buildSql,
  isBinaryType,
  missingViewDeps,
  orderViewsByDependency,
  stripDefiner,
  wrapMysqlDelimiter,
} from '../exportHelper';
import { parseInsert, parseDumpObjects } from '../dumpPreview';
import { splitStatements } from '../../sql/statements';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `n${i + 1}` }));

describe('buildSql', () => {
  it('gộp nhiều dòng vào MỘT câu INSERT', () => {
    const sql = buildSql('users', ['id', 'name'], rows(3), 'mysql');
    expect(sql.match(/INSERT INTO/g)).toHaveLength(1);
    expect(sql).toContain('(1, \'n1\')');
    expect(sql).toContain('(3, \'n3\')');
    expect(sql.trimEnd().endsWith(';')).toBe(true);
  });

  it('cắt thành nhiều câu khi vượt 500 dòng', () => {
    const sql = buildSql('users', ['id', 'name'], rows(1200), 'mysql');
    expect(sql.match(/INSERT INTO/g)).toHaveLength(3); // 500 + 500 + 200
    // Mọi câu đều phải kết thúc bằng ';' để splitter cắt đúng.
    for (const stmt of sql.split('\n').filter((l) => l.startsWith('INSERT INTO'))) {
      expect(stmt.endsWith('VALUES')).toBe(true);
    }
    expect(sql.match(/;/g)).toHaveLength(3);
  });

  it('một dòng dài hơn trần vẫn đi một mình chứ không bị cắt đôi', () => {
    const big = 'x'.repeat(300_000);
    const sql = buildSql('t', ['a'], [{ a: big }, { a: 'nho' }], 'mysql');
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(sql).toContain(big);
  });

  it('escape nháy đơn và NULL như trước', () => {
    const sql = buildSql('t', ['a', 'b'], [{ a: "it's", b: null }], 'mysql');
    expect(sql).toContain("('it''s', NULL)");
  });

  it('dbType khác nhau thì dấu bao identifier khác nhau', () => {
    expect(buildSql('t', ['a'], [{ a: 1 }], 'mysql')).toContain('INSERT INTO `t` (`a`)');
    expect(buildSql('t', ['a'], [{ a: 1 }], 'postgres')).toContain('INSERT INTO "t" ("a")');
  });

  // parseInsert (xem trước lúc nhập) và buildSql (lúc xuất) là một cặp song sinh: dump gộp dòng
  // phải đọc lại được đủ số dòng, nếu không popup Nhập báo sai số lượng.
  it('parseInsert đọc lại đúng số dòng của dump đã gộp', () => {
    const data = rows(1200);
    const sql = buildSql('users', ['id', 'name'], data, 'mysql');
    const stmts = sql.split(/;\r?\n?/).filter((s) => s.trim());
    let total = 0;
    for (const s of stmts) {
      const ins = parseInsert(s);
      expect(ins?.table).toBe('users');
      expect(ins?.columns).toEqual(['id', 'name']);
      total += ins?.rows.length ?? 0;
    }
    expect(total).toBe(1200);
  });

  it('parseInsert đọc đúng giá trị có phẩy/nháy sau khi gộp', () => {
    const sql = buildSql('t', ['a', 'b'], [
      { a: 'x, y', b: "it's" },
      { a: null, b: 2 },
    ], 'mysql');
    const ins = parseInsert(sql.replace(/;$/, ''));
    expect(ins?.rows).toEqual([
      ['x, y', "it's"],
      ['NULL', '2'],
    ]);
  });
});

describe('buildSql — cột nhị phân', () => {
  // Backend giao ô BLOB dưới dạng mảng byte. Không đánh dấu cột thì nó thành chuỗi
  // '[137,80,78,71,...]' — tệp gốc coi như mất mà không có lỗi nào báo.
  const png = [137, 80, 78, 71, 13, 10, 26, 10];

  it('MySQL/SQLite ghi X\'..\', Postgres ghi \'\\x..\'::bytea', () => {
    const bin = new Set(['data']);
    expect(buildSql('t', ['data'], [{ data: png }], 'mysql', bin)).toContain("X'89504e470d0a1a0a'");
    expect(buildSql('t', ['data'], [{ data: png }], 'sqlite', bin)).toContain("X'89504e470d0a1a0a'");
    expect(buildSql('t', ['data'], [{ data: png }], 'postgres', bin)).toContain("'\\x89504e470d0a1a0a'::bytea");
  });

  it('không đánh dấu thì giữ nguyên hành vi cũ (không tự đoán theo giá trị)', () => {
    // Cột JSON chứa [1,2,3] không được biến thành hex -> phải nhìn KIỂU cột, không nhìn giá trị.
    expect(buildSql('t', ['j'], [{ j: [1, 2, 3] }], 'mysql')).toContain("'[1,2,3]'");
  });

  it('NULL và mảng rỗng vẫn đúng', () => {
    const bin = new Set(['data']);
    const sql = buildSql('t', ['data'], [{ data: null }, { data: [] }], 'mysql', bin);
    expect(sql).toContain('(NULL)');
    expect(sql).toContain("(X'')");
  });
});

describe('isBinaryType', () => {
  it('nhận đúng kiểu nhị phân của từng dialect', () => {
    expect(isBinaryType('longblob', 'mysql')).toBe(true);
    expect(isBinaryType('varbinary(255)', 'mysql')).toBe(true);
    expect(isBinaryType('binary(16)', 'mysql')).toBe(true);
    expect(isBinaryType('bytea', 'postgres')).toBe(true);
    expect(isBinaryType('BLOB', 'sqlite')).toBe(true);
  });

  // sakila: `address.location GEOMETRY NOT NULL`. Server trả về byte thô (SRID + WKB); coi nó
  // là kiểu thường thì dump ghi ra '[0,0,0,...]' và lần nhập lại chết.
  it('nhận cả kiểu không gian của MySQL', () => {
    expect(isBinaryType('geometry', 'mysql')).toBe(true);
    expect(isBinaryType('point', 'mysql')).toBe(true);
    expect(isBinaryType('multipolygon', 'mysql')).toBe(true);
    expect(isBinaryType('geomcollection', 'mysql')).toBe(true);
  });

  it('không nhận nhầm kiểu văn bản/số', () => {
    expect(isBinaryType('varchar(45)', 'mysql')).toBe(false);
    expect(isBinaryType('json', 'mysql')).toBe(false);
    expect(isBinaryType('text', 'postgres')).toBe(false);
    // 'bytea' chỉ là kiểu của Postgres; ở MySQL không có kiểu nào tên vậy.
    expect(isBinaryType('text', 'sqlite')).toBe(false);
    expect(isBinaryType(null, 'mysql')).toBe(false);
  });
});

describe('stripDefiner', () => {
  it('bỏ DEFINER của procedure/function/trigger/view', () => {
    expect(stripDefiner('CREATE DEFINER=`root`@`localhost` PROCEDURE `p`() BEGIN END')).toBe(
      'CREATE PROCEDURE `p`() BEGIN END'
    );
    expect(stripDefiner("CREATE DEFINER='admin'@'%' FUNCTION f() RETURNS int RETURN 1")).toBe(
      'CREATE FUNCTION f() RETURNS int RETURN 1'
    );
    expect(stripDefiner('CREATE DEFINER=`root`@`localhost` TRIGGER `t` AFTER INSERT ON `x`')).toBe(
      'CREATE TRIGGER `t` AFTER INSERT ON `x`'
    );
    expect(
      stripDefiner('CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS SELECT 1')
    ).toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS SELECT 1');
  });

  it('không đụng tới SQL SECURITY DEFINER (không có dấu = phía sau)', () => {
    const sql = 'CREATE SQL SECURITY DEFINER VIEW v AS SELECT 1';
    expect(stripDefiner(sql)).toBe(sql);
  });

  it('không đụng câu lệnh không có DEFINER', () => {
    const sql = 'CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW BEGIN END';
    expect(stripDefiner(sql)).toBe(sql);
  });
});

describe('wrapMysqlDelimiter', () => {
  // Thân routine có ';' riêng, nên nếu không đổi delimiter thì bộ tách cắt giữa thân và server
  // nhận được một câu CREATE PROCEDURE cụt.
  it('bộ tách đọc lại đúng MỘT câu cho mỗi routine', () => {
    const body = 'CREATE PROCEDURE p() BEGIN INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END';
    const wrapped = wrapMysqlDelimiter([body, 'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW BEGIN SET @a = 1; END']);
    expect(wrapped[0]).toBe('DELIMITER $$');
    expect(wrapped[wrapped.length - 1]).toBe('DELIMITER ;');

    const stmts = splitStatements(wrapped.join('\n')).map((s) => s.text.trim());
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE PROCEDURE p()');
    expect(stmts[0]).toContain('INSERT INTO t VALUES (2);');
    expect(stmts[1]).toContain('CREATE TRIGGER tr');
  });

  it('bỏ dấu ; thừa ở cuối trước khi gắn $$', () => {
    expect(wrapMysqlDelimiter(['CREATE FUNCTION f() RETURNS int RETURN 1;'])[1]).toBe(
      'CREATE FUNCTION f() RETURNS int RETURN 1$$'
    );
  });

  it('danh sách rỗng thì không sinh khối DELIMITER thừa', () => {
    expect(wrapMysqlDelimiter([])).toEqual([]);
  });
});

// Bên xuất và bên đọc dump là một cặp: tên routine/trigger phải dò lại được từ chính
// những câu mà export ghi ra, nếu không chúng không vào danh sách chọn lúc nhập.
describe('export -> parseDumpObjects', () => {
  it('dò lại được routine/trigger sau khi bọc DELIMITER và bỏ DEFINER', () => {
    const dump = wrapMysqlDelimiter([
      stripDefiner('CREATE DEFINER=`root`@`localhost` PROCEDURE `film_in_stock`(IN id INT) BEGIN SELECT 1; END'),
      stripDefiner('CREATE DEFINER=`root`@`localhost` FUNCTION `get_balance`(id INT) RETURNS DECIMAL(5,2) RETURN 0'),
      stripDefiner('CREATE DEFINER=`root`@`localhost` TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN END'),
    ]).join('\n');

    const objs = parseDumpObjects(dump);
    expect(objs.procedures).toEqual(['film_in_stock']);
    expect(objs.functions).toEqual(['get_balance']);
    expect(objs.triggers).toEqual(['ins_film']);
  });
});

describe('missingViewDeps', () => {
  const view = (name: string, sql: string) => ({ name, sql });

  it('báo bảng mà view đọc nhưng chưa được chọn', () => {
    const out = missingViewDeps(
      [view('film_list', 'CREATE VIEW film_list AS SELECT * FROM film JOIN inventory USING (film_id)')],
      ['film', 'inventory', 'actor'],
      new Set(['film_list', 'film'])
    );
    expect(out).toEqual([{ view: 'film_list', missing: ['inventory'] }]);
  });

  it('chọn đủ bảng thì không cảnh báo', () => {
    const out = missingViewDeps(
      [view('film_list', 'CREATE VIEW film_list AS SELECT * FROM film')],
      ['film'],
      new Set(['film_list', 'film'])
    );
    expect(out).toEqual([]);
  });

  it('so khớp theo biên từ: tên là tiền tố của tên khác không tính', () => {
    const out = missingViewDeps(
      [view('v', 'CREATE VIEW v AS SELECT * FROM film_actor')],
      ['film_actor', 'film'],
      new Set(['v', 'film_actor'])
    );
    expect(out).toEqual([]);
  });

  it('không tự coi chính nó là phụ thuộc', () => {
    const out = missingViewDeps(
      [view('film', 'CREATE VIEW film AS SELECT 1')],
      ['film'],
      new Set(['film'])
    );
    expect(out).toEqual([]);
  });
});

describe('orderViewsByDependency', () => {
  const v = (name: string, sql: string) => ({ name, sql });

  it('view đọc view khác thì view kia đứng trước', () => {
    // Đầu vào theo alphabet: `a_list` đọc `z_base` nhưng lại đứng trước.
    const out = orderViewsByDependency([
      v('a_list', 'CREATE VIEW `a_list` AS SELECT * FROM `z_base`;'),
      v('z_base', 'CREATE VIEW `z_base` AS SELECT * FROM film;'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['z_base', 'a_list']);
  });

  it('so khớp theo biên từ: tên là tiền tố của tên khác không tính là phụ thuộc', () => {
    const out = orderViewsByDependency([
      v('film_list', 'CREATE VIEW `film_list` AS SELECT * FROM film;'),
      v('nicer_but_slower_film_list', 'CREATE VIEW `nicer_but_slower_film_list` AS SELECT * FROM film;'),
    ]);
    // Không view nào phụ thuộc view nào -> giữ nguyên thứ tự đầu vào.
    expect(out.map((x) => x.name)).toEqual(['film_list', 'nicer_but_slower_film_list']);
  });

  it('chuỗi phụ thuộc nhiều tầng được xếp đúng', () => {
    const out = orderViewsByDependency([
      v('c', 'CREATE VIEW c AS SELECT * FROM b;'),
      v('b', 'CREATE VIEW b AS SELECT * FROM a;'),
      v('a', 'CREATE VIEW a AS SELECT * FROM t;'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });

  it('vòng phụ thuộc không làm treo và không mất view nào', () => {
    const out = orderViewsByDependency([
      v('x', 'CREATE VIEW x AS SELECT * FROM y;'),
      v('y', 'CREATE VIEW y AS SELECT * FROM x;'),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.name).sort()).toEqual(['x', 'y']);
  });

  it('giữ đủ mọi view và không nhân bản', () => {
    const input = ['a', 'b', 'c', 'd'].map((n) => v(n, `CREATE VIEW ${n} AS SELECT * FROM t;`));
    const out = orderViewsByDependency(input);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((o) => o.name)).size).toBe(4);
  });

  it('không phân biệt chữ hoa/thường khi dò tên view', () => {
    const out = orderViewsByDependency([
      v('Report', 'CREATE VIEW Report AS SELECT * FROM SALES_BASE;'),
      v('sales_base', 'CREATE VIEW sales_base AS SELECT * FROM t;'),
    ]);
    expect(out.map((x) => x.name)).toEqual(['sales_base', 'Report']);
  });
});
