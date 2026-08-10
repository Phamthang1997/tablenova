import type { DocEntry } from './types';

/**
 * Common SQL statement documentation (DML, DDL, TCL).
 * Helper function to generate docs customized for each target engine (mysql, postgres, sqlite).
 */
export function getCommonSqlDocs(engine: 'mysql' | 'postgres' | 'sqlite'): DocEntry[] {
  return [
    {
      id: `${engine}:select`,
      name: 'SELECT',
      engine,
      category: 'dml',
      syntax: 'SELECT [DISTINCT] column1, column2, ... FROM table_name [WHERE condition] [GROUP BY ...] [HAVING ...] [ORDER BY ...];',
      summary: 'Retrieves data rows from one or more tables or views.',
      summaryVi: 'Truy vấn và lấy dữ liệu từ một hoặc nhiều bảng/view trong CSDL.',
      description: 'The `SELECT` statement is the primary DML query command used to retrieve data from database tables.',
      descriptionVi: 'Câu lệnh `SELECT` là câu truy vấn DML cơ bản nhất dùng để trích xuất dữ liệu từ các bảng trong CSDL.',
      params: [
        { name: 'column1, column2', desc: 'Columns or expressions to return (use * for all columns).' },
        { name: 'table_name', desc: 'Target table or view name.' },
      ],
      returns: 'RESULT-SET',
      examples: [
        "SELECT id, name, email, status\nFROM users\nWHERE status = 'active'\nORDER BY created_at DESC\nLIMIT 10;",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/select.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-select.html'
        : 'https://www.sqlite.org/lang_select.html',
    },
    {
      id: `${engine}:from`,
      name: 'FROM',
      engine,
      category: 'dml',
      syntax: 'FROM table_name [AS alias] [JOIN ...]',
      summary: 'Specifies the source table or view for a query.',
      summaryVi: 'Chỉ định bảng hoặc view nguồn trong câu lệnh SELECT/UPDATE/DELETE.',
      description: 'The `FROM` clause indicates the table(s) from which data is selected, joined, or deleted.',
      descriptionVi: 'Mệnh đề `FROM` xác định các bảng hoặc view làm nguồn dữ liệu cho truy vấn.',
      examples: ['SELECT o.id, o.total FROM orders AS o WHERE o.status = "paid";'],
    },
    {
      id: `${engine}:where`,
      name: 'WHERE',
      engine,
      category: 'dml',
      syntax: 'WHERE condition',
      summary: 'Filters record rows based on specified search conditions.',
      summaryVi: 'Lọc các hàng kết quả dựa trên các điều kiện so sánh logic (AND, OR, NOT, IN, LIKE, BETWEEN).',
      description: 'The `WHERE` clause filters rows before grouping or aggregation takes place.',
      descriptionVi: 'Mệnh đề `WHERE` được dùng để lọc các bản ghi thỏa mãn điều kiện chỉ định trước khi gom nhóm.',
      examples: [
        "SELECT * FROM products WHERE price BETWEEN 10.0 AND 50.0 AND category_id IN (1, 2, 5);",
      ],
    },
    {
      id: `${engine}:join`,
      name: 'JOIN',
      engine,
      category: 'dml',
      syntax: 'SELECT ... FROM table1 [INNER | LEFT | RIGHT | FULL | CROSS] JOIN table2 ON condition',
      summary: 'Combines rows from two or more tables based on a related column.',
      summaryVi: 'Kết hợp các hàng từ hai hay nhiều bảng dựa trên điều kiện liên kết (INNER, LEFT, RIGHT, FULL, CROSS).',
      description: '`JOIN` allows querying data from multiple related tables in a single query result set.',
      descriptionVi: '`JOIN` giúp liên kết các bảng thông qua khóa chính/khóa ngoại để lấy dữ liệu tổng hợp.',
      params: [
        { name: 'INNER JOIN', desc: 'Returns records that have matching values in both tables.' },
        { name: 'LEFT JOIN', desc: 'Returns all records from the left table, and matched records from the right.' },
        { name: 'ON condition', desc: 'Join predicate linking foreign key and primary key columns.' },
      ],
      examples: [
        "SELECT u.id, u.name, COUNT(o.id) AS total_orders\nFROM users u\nLEFT JOIN orders o ON u.id = o.user_id\nGROUP BY u.id, u.name;",
      ],
    },
    {
      id: `${engine}:group_by`,
      name: 'GROUP BY',
      engine,
      category: 'dml',
      syntax: 'GROUP BY column1, column2, ...',
      summary: 'Groups rows that have the same values into summary rows.',
      summaryVi: 'Gom nhóm các hàng có cùng giá trị cột để phục vụ các hàm gộp (COUNT, SUM, AVG, MAX, MIN).',
      description: 'The `GROUP BY` statement groups rows that have the same values into summary rows like "find the number of customers in each country".',
      descriptionVi: 'Mệnh đề `GROUP BY` chia các hàng thành các nhóm có cùng giá trị để tính tổng, trung bình, đếm bản ghi.',
      examples: [
        "SELECT category_id, COUNT(*) AS product_count, AVG(price) AS avg_price\nFROM products\nGROUP BY category_id;",
      ],
    },
    {
      id: `${engine}:having`,
      name: 'HAVING',
      engine,
      category: 'dml',
      syntax: 'HAVING aggregate_condition',
      summary: 'Filters aggregated groups produced by a GROUP BY clause.',
      summaryVi: 'Lọc kết quả sau khi đã gộp nhóm bằng GROUP BY (áp dụng với hàm gộp COUNT, SUM, AVG...).',
      description: 'The `HAVING` clause was added to SQL because the `WHERE` keyword cannot be used with aggregate functions.',
      descriptionVi: 'Mệnh đề `HAVING` dùng để đặt điều kiện lọc trên các kết quả gộp (như COUNT(*) > 5).',
      examples: [
        "SELECT department_id, AVG(salary) AS avg_sal\nFROM employees\nGROUP BY department_id\nHAVING AVG(salary) > 50000;",
      ],
    },
    {
      id: `${engine}:order_by`,
      name: 'ORDER BY',
      engine,
      category: 'dml',
      syntax: 'ORDER BY column1 [ASC | DESC], column2 [ASC | DESC] ...',
      summary: 'Sorts the query result set in ascending or descending order.',
      summaryVi: 'Sắp xếp kết quả truy vấn theo thứ tự tăng dần (ASC - mặc định) hoặc giảm dần (DESC).',
      description: 'The `ORDER BY` keyword is used to sort the result-set in ascending or descending order.',
      descriptionVi: 'Mệnh đề `ORDER BY` dùng để sắp xếp danh sách kết quả theo một hoặc nhiều cột.',
      examples: [
        "SELECT * FROM users ORDER BY status ASC, created_at DESC;",
      ],
    },
    {
      id: `${engine}:limit`,
      name: 'LIMIT',
      engine,
      category: 'dml',
      syntax: 'LIMIT row_count [OFFSET offset_val]',
      summary: 'Constrains the number of rows returned by a query.',
      summaryVi: 'Giới hạn số lượng hàng trả về trong truy vấn, hỗ trợ phân trang với OFFSET.',
      description: 'The `LIMIT` clause limits the number of records returned. Combined with `OFFSET`, it enables page-based pagination.',
      descriptionVi: 'Mệnh đề `LIMIT` giới hạn tối đa số dòng trả về, kết hợp `OFFSET` để làm phân trang (Pagination).',
      examples: [
        "SELECT id, title FROM articles ORDER BY published_at DESC LIMIT 20 OFFSET 40;",
      ],
    },
    {
      id: `${engine}:insert`,
      name: 'INSERT INTO',
      engine,
      category: 'dml',
      syntax: 'INSERT INTO table_name (column1, column2, ...) VALUES (val1, val2, ...);',
      summary: 'Inserts new data records into a database table.',
      summaryVi: 'Thêm một hoặc nhiều bản ghi dữ liệu mới vào bảng CSDL.',
      description: 'The `INSERT INTO` statement is used to insert new records into a table.',
      descriptionVi: 'Câu lệnh `INSERT INTO` thêm hàng mới vào bảng CSDL.',
      examples: [
        "INSERT INTO users (name, email, age)\nVALUES ('Alice', 'alice@example.com', 28),\n       ('Bob', 'bob@example.com', 32);",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/insert.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-insert.html'
        : 'https://www.sqlite.org/lang_insert.html',
    },
    {
      id: `${engine}:update`,
      name: 'UPDATE',
      engine,
      category: 'dml',
      syntax: 'UPDATE table_name SET column1 = val1, column2 = val2, ... WHERE condition;',
      summary: 'Modifies existing records in a table.',
      summaryVi: 'Cập nhật và chỉnh sửa giá trị các bản ghi hiện có trong bảng theo điều kiện WHERE.',
      description: 'The `UPDATE` statement is used to modify the existing records in a table.',
      descriptionVi: 'Câu lệnh `UPDATE` được dùng để sửa đổi dữ liệu đã có trong bảng.',
      examples: [
        "UPDATE users\nSET status = 'verified', updated_at = CURRENT_TIMESTAMP\nWHERE id = 101;",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/update.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-update.html'
        : 'https://www.sqlite.org/lang_update.html',
    },
    {
      id: `${engine}:delete`,
      name: 'DELETE',
      engine,
      category: 'dml',
      syntax: 'DELETE FROM table_name WHERE condition;',
      summary: 'Deletes existing records from a table.',
      summaryVi: 'Xóa các bản ghi thỏa mãn điều kiện khỏi bảng CSDL.',
      description: 'The `DELETE` statement is used to delete existing records in a table.',
      descriptionVi: 'Câu lệnh `DELETE` xóa các bản ghi trong bảng.',
      examples: [
        "DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP;",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/delete.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-delete.html'
        : 'https://www.sqlite.org/lang_delete.html',
    },
    {
      id: `${engine}:with_cte`,
      name: 'WITH',
      engine,
      category: 'dml',
      syntax: 'WITH cte_name [(col1, col2...)] AS (\n  SELECT ...\n)\nSELECT * FROM cte_name;',
      summary: 'Defines a temporary named result set (Common Table Expression / CTE).',
      summaryVi: 'Định nghĩa một bảng tạm có tên (Common Table Expression - CTE) giúp truy vấn phức tạp trở nên gọn gàng.',
      description: 'Common Table Expressions (CTEs) create temporary named result sets that exist only within the execution scope of a single statement.',
      descriptionVi: 'CTE giúp phân tách truy vấn phức tạp thành các khối mạch lạc, dễ đọc và hỗ trợ truy vấn đệ quy (RECURSIVE).',
      examples: [
        "WITH high_value_orders AS (\n  SELECT user_id, SUM(total) AS total_spent\n  FROM orders\n  GROUP BY user_id\n  HAVING SUM(total) > 1000\n)\nSELECT u.name, h.total_spent\nFROM users u\nJOIN high_value_orders h ON u.id = h.user_id;",
      ],
    },
    {
      id: `${engine}:create_table`,
      name: 'CREATE TABLE',
      engine,
      category: 'ddl',
      syntax: 'CREATE TABLE [IF NOT EXISTS] table_name (\n  col1 datatype constraints,\n  col2 datatype constraints,\n  PRIMARY KEY (col1)\n);',
      summary: 'Creates a new table structure in the database schema.',
      summaryVi: 'Tạo mới một bảng dữ liệu trong CSDL với các định nghĩa cột, kiểu dữ liệu và ràng buộc (Constraint).',
      description: 'The `CREATE TABLE` statement is used to create a new table in a database.',
      descriptionVi: 'Câu lệnh DDL `CREATE TABLE` được dùng để thiết lập cấu trúc bảng mới.',
      examples: [
        "CREATE TABLE IF NOT EXISTS users (\n  id INT PRIMARY KEY AUTO_INCREMENT,\n  email VARCHAR(255) NOT NULL UNIQUE,\n  password_hash VARCHAR(255) NOT NULL,\n  status VARCHAR(20) DEFAULT 'active',\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/create-table.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-createtable.html'
        : 'https://www.sqlite.org/lang_createtable.html',
    },
    {
      id: `${engine}:alter_table`,
      name: 'ALTER TABLE',
      engine,
      category: 'ddl',
      syntax: 'ALTER TABLE table_name ADD | DROP | RENAME | MODIFY column_name datatype;',
      summary: 'Modifies the structure of an existing database table.',
      summaryVi: 'Thay đổi cấu trúc của bảng đã tồn tại (Thêm cột, xóa cột, đổi tên, sửa kiểu dữ liệu, thêm khóa).',
      description: 'The `ALTER TABLE` statement is used to add, delete, or modify columns in an existing table.',
      descriptionVi: 'Câu lệnh `ALTER TABLE` cho phép mở rộng hoặc điều chỉnh định nghĩa bảng mà không làm mất dữ liệu hiện có.',
      examples: [
        "ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL;\nALTER TABLE users RENAME COLUMN phone TO mobile_phone;",
      ],
      officialUrl: engine === 'mysql'
        ? 'https://dev.mysql.com/doc/refman/8.0/en/alter-table.html'
        : engine === 'postgres'
        ? 'https://www.postgresql.org/docs/current/sql-altertable.html'
        : 'https://www.sqlite.org/lang_altertable.html',
    },
    {
      id: `${engine}:drop_table`,
      name: 'DROP TABLE',
      engine,
      category: 'ddl',
      syntax: 'DROP TABLE [IF EXISTS] table_name;',
      summary: 'Permanently removes a table and all its data from the database.',
      summaryVi: 'Xóa vĩnh viễn bảng và toàn bộ dữ liệu bên trong khỏi CSDL.',
      description: 'The `DROP TABLE` statement drops an existing table in a database permanently.',
      descriptionVi: 'Câu lệnh `DROP TABLE` xóa hoàn toàn cấu trúc bảng và toàn bộ bản ghi dữ liệu liên quan.',
      examples: [
        "DROP TABLE IF EXISTS temp_migration_data;",
      ],
    },
    {
      id: `${engine}:truncate_table`,
      name: 'TRUNCATE TABLE',
      engine,
      category: 'ddl',
      syntax: 'TRUNCATE [TABLE] table_name;',
      summary: 'Removes all rows from a table quickly and resets auto-increment values.',
      summaryVi: 'Xóa toàn bộ các hàng trong bảng một cách nhanh chóng và reset lại chỉ số tự tăng (Auto Increment).',
      description: '`TRUNCATE TABLE` empties a table completely. It is faster than `DELETE FROM table` because it deallocates data pages.',
      descriptionVi: '`TRUNCATE TABLE` làm rỗng bảng tức thì và giải phóng bộ nhớ hiệu quả hơn lệnh DELETE.',
      examples: [
        "TRUNCATE TABLE app_logs;",
      ],
    },
    {
      id: `${engine}:create_index`,
      name: 'CREATE INDEX',
      engine,
      category: 'ddl',
      syntax: 'CREATE [UNIQUE] INDEX index_name ON table_name (column1, column2...);',
      summary: 'Creates a B-Tree or Hash index to accelerate query lookup speed.',
      summaryVi: 'Tạo chỉ mục Index (B-Tree/Hash) trên một hoặc nhiều cột để tăng tốc độ tìm kiếm SELECT.',
      description: 'Indexes are used to retrieve data from the database more quickly than otherwise.',
      descriptionVi: 'Chỉ mục Index giúp tăng tốc độ truy vấn SELECT nhưng cần lưu ý khi ghi INSERT/UPDATE.',
      examples: [
        "CREATE UNIQUE INDEX idx_users_email ON users (email);",
      ],
    },
    {
      id: `${engine}:drop_index`,
      name: 'DROP INDEX',
      engine,
      category: 'ddl',
      syntax: 'DROP INDEX index_name [ON table_name];',
      summary: 'Removes an existing index from a table.',
      summaryVi: 'Xóa một chỉ mục (Index) đã tạo khỏi bảng CSDL.',
      description: 'The `DROP INDEX` statement is used to delete an index in a table.',
      descriptionVi: 'Câu lệnh `DROP INDEX` loại bỏ chỉ mục Index khỏi bảng.',
      examples: [
        "DROP INDEX idx_users_email ON users;",
      ],
    },
    {
      id: `${engine}:create_view`,
      name: 'CREATE VIEW',
      engine,
      category: 'ddl',
      syntax: 'CREATE VIEW [IF NOT EXISTS] view_name AS SELECT ...;',
      summary: 'Creates a virtual table based on the result set of an SQL query.',
      summaryVi: 'Tạo một bảng ảo (View) lưu trữ câu lệnh truy vấn SELECT để tái sử dụng.',
      description: 'A view is a virtual table based on the result-set of an SQL statement.',
      descriptionVi: 'View là bảng ảo đại diện cho kết quả của một truy vấn SQL, giúp bảo mật và tái sử dụng logic phức tạp.',
      examples: [
        "CREATE VIEW active_users_summary AS\nSELECT u.id, u.name, COUNT(o.id) AS total_orders\nFROM users u JOIN orders o ON u.id = o.user_id\nWHERE u.status = 'active'\nGROUP BY u.id, u.name;",
      ],
    },
    {
      id: `${engine}:transaction`,
      name: 'BEGIN / COMMIT / ROLLBACK',
      engine,
      category: 'transaction',
      syntax: 'BEGIN TRANSACTION;\n-- SQL statements ...\nCOMMIT; -- or ROLLBACK;',
      summary: 'Manages ACID database transactions for atomic multi-statement operations.',
      summaryVi: 'Quản lý giao dịch (Transaction) đảm bảo tính toàn vẹn dữ liệu (ACID - Thành công tất cả hoặc Hủy tất cả).',
      description: 'Transactions ensure that multiple operations complete successfully together (COMMIT) or revert cleanly if any error occurs (ROLLBACK).',
      descriptionVi: 'Giao dịch (Transaction) giúp gom nhóm nhiều câu lệnh SQL thành một thao tác nguyên tử (Atomic operation).',
      examples: [
        "BEGIN TRANSACTION;\nUPDATE accounts SET balance = balance - 500 WHERE id = 1;\nUPDATE accounts SET balance = balance + 500 WHERE id = 2;\nCOMMIT;",
      ],
    },
  ];
}
