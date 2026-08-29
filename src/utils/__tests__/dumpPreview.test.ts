import { describe, it, expect } from 'vitest';
import {
  parseCreateTable,
  parseInsert,
  parseDumpDatabase,
  parseDumpObjects,
  parseDumpTableNames,
  dumpStatementObject,
  buildDropStatements,
  stripLeadingSqlComments,
  isSkippedDumpStatement,
  isCommentOnlyStatement,
} from '../dumpPreview';

const SAKILA_LIKE = `
USE sakila;
CREATE TABLE actor (actor_id SMALLINT NOT NULL);
CREATE TABLE film_text (film_id SMALLINT NOT NULL);
DELIMITER ;;
CREATE TRIGGER \`ins_film\` AFTER INSERT ON \`film\` FOR EACH ROW BEGIN
  INSERT INTO film_text (film_id) VALUES (new.film_id);
END;;
DELIMITER ;
CREATE VIEW customer_list AS SELECT 1;
CREATE DEFINER=CURRENT_USER SQL SECURITY INVOKER VIEW actor_info AS SELECT 1;
CREATE PROCEDURE rewards_report (IN x INT) BEGIN SELECT 1; END;
CREATE FUNCTION get_customer_balance(p INT) RETURNS DECIMAL(5,2) BEGIN RETURN 0; END;
`;

describe('stripLeadingSqlComments / isSkippedDumpStatement', () => {
  // A mysqldump file glues a comment directly in front of a statement and the splitter keeps that
  // comment in the statement text -> classification has to strip comments first, or LOCK TABLES slips
  // through and causes MySQL 1100 on the next table.
  const lockStmt = '--\n-- Dumping data for table `store`\n--\n\nLOCK TABLES `store` WRITE';

  it('bỏ comment dòng, comment khối và khoảng trắng ở đầu câu', () => {
    expect(stripLeadingSqlComments(lockStmt)).toBe('LOCK TABLES `store` WRITE');
    expect(stripLeadingSqlComments('/* c1 */ /* c2 */\n# a note\nSELECT 1')).toBe('SELECT 1');
    expect(stripLeadingSqlComments('-- ghi chú tiếng Việt\nSELECT 1')).toBe('SELECT 1');
  });

  it('nhận đúng câu bị bỏ qua dù có comment che phía trước', () => {
    expect(isSkippedDumpStatement(lockStmt)).toBe(true);
    expect(isSkippedDumpStatement('-- x\nUNLOCK TABLES')).toBe(true);
    expect(isSkippedDumpStatement('COMMIT')).toBe(true);
    expect(isSkippedDumpStatement('START TRANSACTION')).toBe(true);
    // INSERT/CREATE still run
    expect(isSkippedDumpStatement('-- x\nINSERT INTO store VALUES (1)')).toBe(false);
    // A routine body starts with CREATE, so the BEGIN inside it is not mistaken for one
    expect(isSkippedDumpStatement('CREATE TRIGGER t AFTER INSERT ON f FOR EACH ROW BEGIN\nSELECT 1;\nEND')).toBe(false);
  });

  it('câu chỉ có comment: comment điều kiện MySQL vẫn chạy, comment thường thì không', () => {
    expect(isCommentOnlyStatement('/*!40101 SET NAMES utf8mb4 */')).toEqual({ commentOnly: true, willRun: true });
    expect(isCommentOnlyStatement('--\n-- Table structure\n--')).toEqual({ commentOnly: true, willRun: false });
    expect(isCommentOnlyStatement('-- x\nSELECT 1')).toEqual({ commentOnly: false, willRun: true });
  });
});

describe('parseDumpObjects', () => {
  it('liệt kê đủ bảng, view, trigger, procedure, function', () => {
    const o = parseDumpObjects(SAKILA_LIKE);
    expect(o.tables).toEqual(['actor', 'film_text']);
    // A view carrying DEFINER / SQL SECURITY is still named correctly
    expect(o.views).toEqual(['customer_list', 'actor_info']);
    expect(o.triggers).toEqual(['ins_film']);
    expect(o.procedures).toEqual(['rewards_report']);
    expect(o.functions).toEqual(['get_customer_balance']);
  });
});

describe('buildDropStatements', () => {
  it('MySQL: xoá theo thứ tự trigger -> view -> routine -> table, quote bằng backtick', () => {
    const stmts = buildDropStatements(parseDumpObjects(SAKILA_LIKE), 'mysql');
    expect(stmts).toEqual([
      'DROP TRIGGER IF EXISTS `ins_film`;',
      'DROP VIEW IF EXISTS `customer_list`;',
      'DROP VIEW IF EXISTS `actor_info`;',
      'DROP PROCEDURE IF EXISTS `rewards_report`;',
      'DROP FUNCTION IF EXISTS `get_customer_balance`;',
      'DROP TABLE IF EXISTS `actor`;',
      'DROP TABLE IF EXISTS `film_text`;',
    ]);
  });

  it('Postgres: chỉ view/table kèm CASCADE (trigger cần ON table, function cần chữ ký)', () => {
    const stmts = buildDropStatements(parseDumpObjects(SAKILA_LIKE), 'postgres');
    expect(stmts).toEqual([
      'DROP VIEW IF EXISTS "customer_list" CASCADE;',
      'DROP VIEW IF EXISTS "actor_info" CASCADE;',
      'DROP TABLE IF EXISTS "actor" CASCADE;',
      'DROP TABLE IF EXISTS "film_text" CASCADE;',
    ]);
  });

  it('SQLite: không có procedure/function', () => {
    const stmts = buildDropStatements(parseDumpObjects(SAKILA_LIKE), 'sqlite');
    expect(stmts.some(s => s.includes('PROCEDURE') || s.includes('FUNCTION'))).toBe(false);
    expect(stmts).toContain('DROP TRIGGER IF EXISTS "ins_film";');
  });
});

describe('parseDumpDatabase', () => {
  it('lấy tên từ USE (ưu tiên) kể cả khi có CREATE SCHEMA trước đó', () => {
    const sql = 'DROP SCHEMA IF EXISTS sakila;\nCREATE SCHEMA sakila;\nUSE sakila;\nCREATE TABLE a (id INT);';
    expect(parseDumpDatabase(sql)).toBe('sakila');
  });

  it('lấy tên từ CREATE DATABASE khi tệp không có USE', () => {
    expect(parseDumpDatabase('CREATE DATABASE IF NOT EXISTS `shop_v2`;\nCREATE TABLE a (id INT);')).toBe('shop_v2');
  });

  it('bỏ dấu bao quanh tên', () => {
    expect(parseDumpDatabase('USE `my-db`;')).toBe('my-db');
    expect(parseDumpDatabase('USE "My_DB";')).toBe('My_DB');
  });

  it('trả null khi dump không nhắc database nào', () => {
    expect(parseDumpDatabase('CREATE TABLE a (id INT);\nINSERT INTO a VALUES (1);')).toBeNull();
  });
});

describe('parseCreateTable', () => {
  it('đọc cột, kiểu và cờ NOT NULL / PK / auto increment (MySQL)', () => {
    const t = parseCreateTable(
      'CREATE TABLE `users` (\n' +
      '  `id` int(11) NOT NULL AUTO_INCREMENT,\n' +
      '  `email` varchar(255) NOT NULL,\n' +
      "  `note` text DEFAULT 'a, b',\n" +
      '  PRIMARY KEY (`id`),\n' +
      '  UNIQUE KEY `uq_email` (`email`)\n' +
      ') ENGINE=InnoDB'
    );
    expect(t?.name).toBe('users');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'email', 'note']);
    expect(t?.columns[0].notNull).toBe(true);
    expect(t?.columns[0].autoIncrement).toBe(true);
    // A table-level PRIMARY KEY has to be marked back onto the column
    expect(t?.columns[0].primaryKey).toBe(true);
    expect(t?.columns[1].primaryKey).toBe(false);
    // A DEFAULT holding a comma inside its string must not split the columns wrongly
    expect(t?.columns[2].defaultValue).toBe("'a, b'");
    expect(t?.constraints.some((c) => c.startsWith('UNIQUE KEY'))).toBe(true);
  });

  it('đọc Postgres với schema, kiểu có tham số và IF NOT EXISTS', () => {
    const t = parseCreateTable(
      'CREATE TABLE IF NOT EXISTS public."Trip" (\n' +
      '  id bigserial PRIMARY KEY,\n' +
      '  price numeric(12, 2) NOT NULL DEFAULT 0,\n' +
      '  created_at timestamp with time zone\n' +
      ')'
    );
    expect(t?.name).toBe('Trip');
    expect(t?.columns.map((c) => c.name)).toEqual(['id', 'price', 'created_at']);
    // numeric(12, 2) holds a comma inside parentheses -> still one column
    expect(t?.columns[1].type).toContain('numeric(12, 2)');
    expect(t?.columns[1].defaultValue).toBe('0');
    expect(t?.columns[0].primaryKey).toBe(true);
    expect(t?.columns[2].notNull).toBe(false);
  });

  it('trả null với câu lệnh không phải CREATE TABLE', () => {
    expect(parseCreateTable('CREATE INDEX idx ON users (email)')).toBeNull();
    expect(parseCreateTable('INSERT INTO users VALUES (1)')).toBeNull();
  });
});

describe('parseInsert', () => {
  it('đọc danh sách cột và nhiều tuple giá trị', () => {
    const r = parseInsert(
      "INSERT INTO `users` (`id`, `email`) VALUES (1, 'a@b.c'), (2, 'x@y.z')"
    );
    expect(r?.table).toBe('users');
    expect(r?.columns).toEqual(['id', 'email']);
    expect(r?.rows).toEqual([
      ['1', 'a@b.c'],
      ['2', 'x@y.z'],
    ]);
  });

  it('giữ nguyên phẩy và nháy escape trong chuỗi', () => {
    const r = parseInsert("INSERT INTO t (a, b) VALUES ('x, y', 'it''s')");
    expect(r?.rows[0]).toEqual(['x, y', "it's"]);
  });

  it('không có danh sách cột thì columns = null', () => {
    const r = parseInsert('INSERT INTO t VALUES (1, NULL)');
    expect(r?.columns).toBeNull();
    expect(r?.rows[0]).toEqual(['1', 'NULL']);
  });

  it('trả null với câu lệnh khác', () => {
    expect(parseInsert('UPDATE t SET a = 1')).toBeNull();
  });

  // Export packs up to 500 rows into one INSERT -> the tuple reader has to be O(n), and has to read them all.
  it('đọc đủ dòng của một INSERT gộp nhiều dòng', () => {
    const tuples = Array.from({ length: 500 }, (_, i) => `(${i}, 'name ${i}')`).join(',\n');
    const r = parseInsert(`INSERT INTO \`t\` (\`id\`, \`name\`) VALUES\n${tuples}`);
    expect(r?.rows).toHaveLength(500);
    expect(r?.rows[0]).toEqual(['0', 'name 0']);
    expect(r?.rows[499]).toEqual(['499', 'name 499']);
  });

  it('không ăn vào phần đuôi sau danh sách tuple', () => {
    const r = parseInsert(
      "INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y') ON DUPLICATE KEY UPDATE b = VALUES(b)"
    );
    expect(r?.rows).toEqual([
      ['1', 'x'],
      ['2', 'y'],
    ]);
  });

  it('ngoặc và phẩy nằm trong chuỗi không cắt sai tuple', () => {
    const r = parseInsert("INSERT INTO t (a) VALUES ('a),(b'), ('c')");
    expect(r?.rows).toEqual([['a),(b'], ['c']]);
  });
});

describe('parseDumpTableNames', () => {
  it('dò bảng từ CREATE TABLE / INSERT INTO / DROP TABLE IF EXISTS', () => {
    const sql = [
      'DROP TABLE IF EXISTS `actor`;',
      'CREATE TABLE `actor` (id int);',
      "INSERT INTO `payment` VALUES (1);",
    ].join('\n');
    expect(parseDumpTableNames(sql)).toEqual(['actor', 'payment']);
  });

  // Why this function exists: a view is written with CREATE VIEW / DROP VIEW, not DROP TABLE.
  // Undetected, the view never reaches the selection list and the backend drops its statements.
  it('dò cả view, kể cả dạng có ALGORITHM/DEFINER/SQL SECURITY', () => {
    const sql = [
      'DROP VIEW IF EXISTS `actor_info`;',
      'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `actor_info` AS select 1;',
      'CREATE VIEW `film_list` AS select * from film;',
      'CREATE OR REPLACE VIEW "staff_list" AS select 1;',
    ].join('\n');
    // Only the name of the object being CREATED, not a table read inside the view body (`from film`).
    expect(parseDumpTableNames(sql)).toEqual(['actor_info', 'film_list', 'staff_list']);
  });

  // The routine's own name must be listed: the backend only runs statements mentioning a name
  // from this list (`stmt_mentions_table`), so a CREATE PROCEDURE touching no selected table
  // used to be dropped from the restore. The TEMPORARY table inside its body stays excluded —
  // that one is not an object of the database.
  it('lấy tên routine nhưng bỏ bảng tạm khai báo trong thân', () => {
    const sql = [
      'CREATE TABLE `real_table` (id int);',
      'CREATE PROCEDURE p() BEGIN CREATE TEMPORARY TABLE tmp_x (id int); INSERT INTO tmp_x VALUES (1); END',
    ].join('\n');
    expect(parseDumpTableNames(sql)).toEqual(['real_table', 'p']);
  });

  it('dò trigger / procedure / function, kể cả dạng có DEFINER', () => {
    const sql = [
      'DROP TRIGGER IF EXISTS `ins_film`;',
      'CREATE DEFINER=`root`@`localhost` TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN END;',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `film_in_stock`(IN p_film_id INT) BEGIN END;',
      'CREATE OR REPLACE FUNCTION "held_by_customer"(p_id int) RETURNS int AS $$ BEGIN RETURN 1; END $$;',
    ].join('\n');
    expect(parseDumpTableNames(sql)).toEqual(['ins_film', 'film_in_stock', 'held_by_customer']);
  });

  it('không lặp tên và giữ thứ tự xuất hiện', () => {
    const sql = 'INSERT INTO b VALUES (1); INSERT INTO a VALUES (1); INSERT INTO b VALUES (2);';
    expect(parseDumpTableNames(sql)).toEqual(['b', 'a']);
  });
});

describe('dumpStatementObject', () => {
  it('lấy tên của đối tượng đầu tiên trong câu lệnh', () => {
    expect(dumpStatementObject('INSERT INTO `film` VALUES (1)')).toBe('film');
    expect(dumpStatementObject('DROP TABLE IF EXISTS "city"')).toBe('city');
    expect(dumpStatementObject('CREATE TABLE IF NOT EXISTS x (id int)')).toBe('x');
  });

  it('với CREATE VIEW thì lấy tên view, không phải bảng trong thân', () => {
    expect(
      dumpStatementObject(
        'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY INVOKER VIEW `actor_info` AS select * from `film`'
      )
    ).toBe('actor_info');
    expect(dumpStatementObject('DROP VIEW IF EXISTS `actor_info`')).toBe('actor_info');
  });

  it('với routine/trigger thì lấy tên của chính nó', () => {
    expect(
      dumpStatementObject('CREATE DEFINER=`root`@`localhost` PROCEDURE `film_in_stock`(IN id INT) BEGIN SELECT 1; END')
    ).toBe('film_in_stock');
    expect(dumpStatementObject('CREATE TRIGGER `ins_film` AFTER INSERT ON `film` FOR EACH ROW BEGIN END')).toBe('ins_film');
    expect(dumpStatementObject('DROP FUNCTION IF EXISTS `get_customer_balance`')).toBe('get_customer_balance');
  });

  it('câu không nhắc bảng nào thì trả null', () => {
    expect(dumpStatementObject('SET NAMES utf8mb4')).toBeNull();
    expect(dumpStatementObject('USE `sakila`')).toBeNull();
  });
});
