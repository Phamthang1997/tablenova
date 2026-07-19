export interface QueryParamsConfig {
  enabled: boolean;
  patternIndex: number; // 0, 1, 2, 3
}

export interface QueryParamPattern {
  id: number;
  label: string;
  example: string;
  regex: RegExp;
  isPositional?: boolean;
}

export const QUERY_PARAM_PATTERNS: QueryParamPattern[] = [
  {
    id: 0,
    label: ':[\w.]',
    example: 'SELECT * FROM users WHERE id = :user_id AND org = :org.id',
    regex: /(?<!:):([a-zA-Z0-9_.]+)/g
  },
  {
    id: 1,
    label: '%[\w.]%',
    example: 'SELECT * FROM users WHERE id = %user_id% AND org = %org.id%',
    regex: /%([a-zA-Z0-9_.]+)%/g
  },
  {
    id: 2,
    label: '?',
    example: 'SELECT * FROM users WHERE id = ? AND status = ?',
    regex: /\?/g,
    isPositional: true
  },
  {
    id: 3,
    label: '${[\w.]+}',
    example: 'SELECT * FROM users WHERE id = ${user_id} AND org = ${org.id}',
    regex: /\$\{([a-zA-Z0-9_.]+)\}/g
  }
];

export const DEFAULT_QUERY_PARAMS_CONFIG: QueryParamsConfig = {
  enabled: false,
  patternIndex: 0
};

export function getQueryParamsConfig(): QueryParamsConfig {
  const stored = localStorage.getItem('sql_query_params_config');
  if (!stored) return DEFAULT_QUERY_PARAMS_CONFIG;
  try {
    const parsed = JSON.parse(stored);
    return {
      enabled: Boolean(parsed.enabled),
      patternIndex: typeof parsed.patternIndex === 'number' && parsed.patternIndex >= 0 && parsed.patternIndex <= 3 ? parsed.patternIndex : 0
    };
  } catch {
    return DEFAULT_QUERY_PARAMS_CONFIG;
  }
}

export function saveQueryParamsConfig(config: QueryParamsConfig): void {
  localStorage.setItem('sql_query_params_config', JSON.stringify(config));
}

/**
 * Strips comments and string literals to prevent matching parameter syntax inside strings or comments
 */
export function stripCommentsAndStrings(sql: string): string {
  if (!sql) return '';
  return sql
    // Remove single line comments
    .replace(/--.*$/gm, '')
    // Remove block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Replace string literals with spaces of equal length to preserve string offsets
    .replace(/('[^']*'|"[^"]*"|`[^`]*`)/g, (m) => ' '.repeat(m.length));
}

/**
 * Trả về một chuỗi CÙNG ĐỘ DÀI với `sql`, trong đó mọi ký tự thuộc comment (-- , /* *​/)
 * hoặc chuỗi ('...', "...", `...`) bị thay bằng khoảng trắng, còn lại giữ nguyên.
 * Nhờ giữ nguyên offset, ta có thể kiểm tra một match ở vị trí `offset` có nằm trong
 * vùng comment/chuỗi hay không bằng cách so `mask[offset]` với `sql[offset]`.
 */
export function maskCommentsAndStrings(sql: string): string {
  if (!sql) return '';
  const n = sql.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // Comment dòng: -- ... đến hết dòng
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Comment khối: /* ... */
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // Chuỗi: ' " ` (xử lý escape nháy đôi '' trong chuỗi nháy đơn)
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
          out += ' '; i++; break;
        }
        out += sql[i] === '\n' ? '\n' : ' '; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * Extracts parameter tokens from SQL string using active regex pattern
 */
export function extractQueryParams(sql: string, patternIndex: number): string[] {
  if (!sql.trim()) return [];
  const patternObj = QUERY_PARAM_PATTERNS[patternIndex] || QUERY_PARAM_PATTERNS[0];
  // Dò trên mask (cùng độ dài) nên param nằm trong comment/chuỗi (đã thành khoảng trắng) sẽ không khớp
  const cleanSql = maskCommentsAndStrings(sql);

  const matches: string[] = [];

  if (patternObj.isPositional) {
    let count = 0;
    const re = new RegExp(patternObj.regex.source, 'g');
    while (re.exec(cleanSql) !== null) {
      count++;
      matches.push(`Tham số ? #${count}`);
    }
    return matches;
  }

  const re = new RegExp(patternObj.regex.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleanSql)) !== null) {
    const paramName = match[0];
    if (!matches.includes(paramName)) {
      matches.push(paramName);
    }
  }

  return matches;
}

/**
 * Substitutes parameter values into the original SQL string
 */
export function substituteQueryParams(
  sql: string,
  patternIndex: number,
  valuesMap: Record<string, string>
): string {
  if (!sql.trim()) return sql;
  const patternObj = QUERY_PARAM_PATTERNS[patternIndex] || QUERY_PARAM_PATTERNS[0];

  // Mask cùng độ dài với sql: một match ở vị trí `offset` nằm trong comment/chuỗi
  // khi và chỉ khi ký tự đầu của nó bị thay khác đi trong mask (thành khoảng trắng).
  const mask = maskCommentsAndStrings(sql);
  const isMasked = (offset: number) => mask[offset] !== sql[offset];

  if (patternObj.isPositional) {
    let index = 0;
    return sql.replace(/\?/g, (match, offset) => {
      if (isMasked(offset)) return match; // ? nằm trong chuỗi/comment -> giữ nguyên
      index++;
      const key = `Tham số ? #${index}`;
      return valuesMap[key] !== undefined ? valuesMap[key] : '';
    });
  }

  // Named parameters
  const re = new RegExp(patternObj.regex.source, 'g');
  return sql.replace(re, (match, p1, offset) => {
    if (isMasked(offset)) return match;
    return valuesMap[match] !== undefined ? valuesMap[match] : (valuesMap[p1] !== undefined ? valuesMap[p1] : match);
  });
}
