import { describe, it, expect } from 'vitest';
import {
  resolveResultEditability,
  type EditableSchemaLike,
  type NotEditableReason,
} from '../../sql/editableResult';

const SCHEMA: Record<string, EditableSchemaLike> = {
  users: {
    columns: [
      { name: 'id', isPrimaryKey: true },
      { name: 'name' },
      { name: 'email' },
      { name: 'age' },
    ],
  },
  orders: {
    columns: [
      { name: 'order_id', isPrimaryKey: true },
      { name: 'user_id' },
      { name: 'total' },
    ],
  },
  // Composite key — `commit_changes` cannot address a row with it.
  order_items: {
    columns: [
      { name: 'order_id', isPrimaryKey: true },
      { name: 'line_no', isPrimaryKey: true },
      { name: 'qty' },
    ],
  },
  // No key at all.
  audit_log: {
    columns: [{ name: 'at' }, { name: 'message' }],
  },
};

const get = (t: string) => SCHEMA[t] ?? null;

const USERS_COLS = ['id', 'name', 'email', 'age'];

/** Ngắn gọn cho các ca chỉ cần biết lý do bị từ chối. */
function reasonOf(sql: string, cols: string[] = USERS_COLS): NotEditableReason | 'EDITABLE' {
  const r = resolveResultEditability(sql, cols, get);
  return r.editable ? 'EDITABLE' : r.reason;
}

describe('resolveResultEditability — ca cho sửa được', () => {
  it('SELECT * FROM users', () => {
    const r = resolveResultEditability('SELECT * FROM users', USERS_COLS, get);
    expect(r).toEqual({ editable: true, table: 'users', primaryKey: 'id', columns: USERS_COLS });
  });

  it('danh sách cột tường minh, có WHERE / ORDER BY / LIMIT', () => {
    const r = resolveResultEditability(
      'SELECT id, name FROM users WHERE age > 30 ORDER BY name LIMIT 10',
      ['id', 'name'],
      get
    );
    expect(r).toEqual({ editable: true, table: 'users', primaryKey: 'id', columns: ['id', 'name'] });
  });

  it('bảng có alias', () => {
    const r = resolveResultEditability('SELECT u.id, u.name FROM users u', ['id', 'name'], get);
    expect(r.editable).toBe(true);
  });

  it('định danh có trích dẫn theo từng dialect', () => {
    expect(resolveResultEditability('SELECT `id`, `name` FROM `users`', ['id', 'name'], get).editable).toBe(true);
    expect(resolveResultEditability('SELECT "id", "name" FROM "users"', ['id', 'name'], get).editable).toBe(true);
  });

  it('subquery trong WHERE không ảnh hưởng — dòng vẫn là dòng của users', () => {
    const r = resolveResultEditability(
      'SELECT id, name FROM users WHERE id IN (SELECT user_id FROM orders)',
      ['id', 'name'],
      get
    );
    expect(r).toMatchObject({ editable: true, table: 'users' });
  });

  it('bỏ qua dấu ; cuối câu, khoảng trắng và comment', () => {
    expect(reasonOf('  -- lấy người dùng\n  SELECT * FROM users ;  ')).toBe('EDITABLE');
  });

  it('có schema đứng trước tên bảng', () => {
    const r = resolveResultEditability('SELECT * FROM public.users', USERS_COLS, get);
    expect(r).toMatchObject({ editable: true, table: 'users' });
  });

  it('cột trả về không thuộc bảng thì chỉ cột đó bị loại, phần còn lại vẫn sửa được', () => {
    // Trùng tên cột được backend hậu tố hoá (uniquify_columns) -> không khớp schema.
    const r = resolveResultEditability('SELECT * FROM users', ['id', 'name', 'name (2)'], get);
    expect(r).toEqual({ editable: true, table: 'users', primaryKey: 'id', columns: ['id', 'name'] });
  });

  it('cache schema cũ hơn câu lệnh: cột không được chọn thì không lọt vào danh sách sửa', () => {
    const r = resolveResultEditability('SELECT id, name FROM users', ['id', 'name'], get);
    expect(r.editable && r.columns).toEqual(['id', 'name']);
  });
});

describe('resolveResultEditability — ca bị từ chối', () => {
  it('không phải SELECT', () => {
    expect(reasonOf('UPDATE users SET name = 1')).toBe('notSelect');
    expect(reasonOf('INSERT INTO users (name) VALUES (1)')).toBe('notSelect');
    expect(reasonOf('CREATE TABLE users (id int)')).toBe('notSelect');
  });

  it('JOIN', () => {
    expect(reasonOf('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id', ['id'])).toBe('multiTable');
  });

  it('FROM nhiều bảng ngăn bằng dấu phẩy', () => {
    expect(reasonOf('SELECT id FROM users, orders', ['id'])).toBe('multiTable');
  });

  it('derived table — đây là ca collectTableRefs() báo nhầm 1 bảng', () => {
    expect(reasonOf('SELECT * FROM (SELECT * FROM users) x')).toBe('derivedTable');
  });

  it('CTE', () => {
    expect(reasonOf('WITH x AS (SELECT * FROM users) SELECT * FROM x')).toBe('notSimple');
  });

  it('DISTINCT / GROUP BY / HAVING / UNION', () => {
    expect(reasonOf('SELECT DISTINCT name FROM users', ['name'])).toBe('notSimple');
    expect(reasonOf('SELECT age FROM users GROUP BY age', ['age'])).toBe('notSimple');
    expect(reasonOf('SELECT age FROM users GROUP BY age HAVING age > 1', ['age'])).toBe('notSimple');
    expect(reasonOf('SELECT id FROM users UNION SELECT order_id FROM orders', ['id'])).toBe('notSimple');
  });

  it('biểu thức, hàm hoặc alias trong danh sách cột', () => {
    expect(reasonOf('SELECT id, upper(name) AS name FROM users', ['id', 'name'])).toBe('computedColumns');
    expect(reasonOf('SELECT id, name AS n FROM users', ['id', 'n'])).toBe('computedColumns');
    expect(reasonOf('SELECT id, age + 1 FROM users', ['id', 'age'])).toBe('computedColumns');
    expect(reasonOf('SELECT count(*) FROM users', ['count'])).toBe('computedColumns');
  });

  it('SELECT không có FROM', () => {
    expect(reasonOf('SELECT 1', ['1'])).toBe('notSimple');
  });

  it('chưa có schema trong cache — kèm tên bảng để nạp rồi thử lại', () => {
    const r = resolveResultEditability('SELECT * FROM unknown_tbl', ['a'], get);
    expect(r).toEqual({ editable: false, reason: 'unknownTable', table: 'unknown_tbl' });
  });

  it('khoá chính phức hợp hoặc không có khoá chính', () => {
    const r1 = resolveResultEditability('SELECT * FROM order_items', ['order_id', 'line_no', 'qty'], get);
    expect(r1).toEqual({ editable: false, reason: 'noPrimaryKey', table: 'order_items' });
    const r2 = resolveResultEditability('SELECT * FROM audit_log', ['at', 'message'], get);
    expect(r2).toMatchObject({ editable: false, reason: 'noPrimaryKey' });
  });

  it('khoá chính không nằm trong kết quả', () => {
    const r = resolveResultEditability('SELECT name, email FROM users', ['name', 'email'], get);
    expect(r).toEqual({ editable: false, reason: 'pkNotSelected', table: 'users' });
  });

  it('kết quả rỗng cột (câu lệnh ghi) không bao giờ sửa được', () => {
    expect(resolveResultEditability('SELECT * FROM users', [], get).editable).toBe(false);
  });

  it('từ khoá nằm trong chuỗi/comment không bị tính là JOIN hay GROUP BY', () => {
    expect(reasonOf("SELECT * FROM users WHERE name = 'join me'")).toBe('EDITABLE');
    expect(reasonOf('SELECT * FROM users /* group by age */')).toBe('EDITABLE');
  });
});
