// Làm đẹp / nén SQL. Dùng sql-formatter (parser theo đúng dialect) thay vì regex thuần
// nên giữ được CTE, subquery lồng nhau, CASE WHEN, window function...
import { format as sqlFormat } from 'sql-formatter';

export type SqlDialect = 'mysql' | 'postgresql' | 'sqlite' | 'sql';

export function formatterDialect(dbType?: string): SqlDialect {
  switch (dbType) {
    case 'mysql': return 'mysql';
    case 'postgres': return 'postgresql';
    case 'sqlite': return 'sqlite';
    default: return 'sql';
  }
}

// Cho phép mọi kiểu placeholder mà app hỗ trợ (:name, ?, %name%, ${name}) để formatter
// không coi chúng là lỗi cú pháp và không phá vỡ câu lệnh.
const PARAM_TYPES = {
  positional: true,
  named: [':', '@'],
  custom: [{ regex: String.raw`%[\w.]+%` }, { regex: String.raw`\$\{[\w.]+\}` }],
} as const;

/**
 * Làm đẹp SQL theo dialect. Câu lệnh chưa hoàn chỉnh (đang gõ dở) khiến parser lỗi ->
 * trả nguyên văn bản gốc thay vì làm hỏng nội dung người dùng.
 */
export function formatSql(sql: string, dbType?: string): string {
  if (!sql.trim()) return sql;
  try {
    return sqlFormat(sql, {
      language: formatterDialect(dbType),
      keywordCase: 'upper',
      dataTypeCase: 'upper',
      functionCase: 'upper',
      identifierCase: 'preserve',
      indentStyle: 'standard',
      tabWidth: 2,
      useTabs: false,
      linesBetweenQueries: 1,
      expressionWidth: 80,
      paramTypes: PARAM_TYPES as any,
    });
  } catch {
    return sql;
  }
}

/**
 * Nén về 1 dòng: bỏ comment, gộp khoảng trắng, bỏ khoảng trắng thừa quanh dấu câu.
 * Nội dung bên trong chuỗi ('...', "...", `...`) được giữ NGUYÊN VẸN.
 */
export function minifySql(sql: string): string {
  if (!sql.trim()) return sql;
  const n = sql.length;
  let out = '';
  const endsWithSpace = () => out.endsWith(' ');
  const addSpace = () => {
    // Không thêm khoảng trắng ở đầu, sau '(' hoặc sau khoảng trắng đã có
    if (!out || endsWithSpace() || out.endsWith('(')) return;
    out += ' ';
  };

  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // Comment dòng: -- ... hết dòng  |  Comment khối: /* ... */
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') i++;
      addSpace();
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      addSpace();
      continue;
    }

    // Chuỗi / identifier có dấu: copy nguyên khối (kể cả '' escape)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (/\s/.test(c)) {
      addSpace();
      i++;
      continue;
    }

    // Bỏ khoảng trắng trước dấu câu đóng
    if ((c === ',' || c === ';' || c === ')') && endsWithSpace()) out = out.slice(0, -1);
    out += c;
    i++;
  }

  return out.trim();
}
