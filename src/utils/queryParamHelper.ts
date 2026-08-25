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
    // Nhãn này is render for user xem. must escape thành '\\w': in
    // string JS thì '\w' is hiểu is 'w' (backslash is ăn mất) nên UI currently hiện
    // sai thành ':[w.]'.
    label: ':[\\w.]',
    example: 'SELECT * FROM users WHERE id = :user_id AND org = :org.id',
    regex: /(?<!:):([a-zA-Z0-9_.]+)/g
  },
  {
    id: 1,
    label: '%[\\w.]%',
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
    label: '${[\\w.]+}',
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
 * returns một string CÙNG ĐỘ DÀI with `sql`, in đó mọi character thuộc comment (-- , /* *​/)
 * or string ('...', "...", `...`) is thay bằng whitespace, còn lại preserve.
 * Nhờ preserve offset, ta can check một match at position `offset` có nằm in
 * vùng comment/string hay not bằng cách so `mask[offset]` with `sql[offset]`.
 */
export function maskCommentsAndStrings(sql: string): string {
  if (!sql) return '';
  const n = sql.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // Comment row: -- ... đến hết row
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
    // string: ' " ` (handle escape nháy đôi '' in string nháy đơn)
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
/**
 * Identity of a positional (`?`) parameter.
 *
 * Deliberately NOT localized: this string is the key of the value map, and that map
 * is persisted in localStorage (`sql_query_param_values`). If it followed the UI
 * language, switching language would orphan every saved value and the extract and
 * substitute passes could disagree. The human-readable label is produced at render
 * time instead — see `positionalParamIndex()` and `queryParams.positionalParam`.
 */
export function positionalParamKey(index: number): string {
  return `?#${index}`;
}

/** Index of a positional key, or null for a named parameter. Used to build its label. */
export function positionalParamIndex(name: string): number | null {
  const m = /^\?#(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

export function extractQueryParams(sql: string, patternIndex: number): string[] {
  if (!sql.trim()) return [];
  const patternObj = QUERY_PARAM_PATTERNS[patternIndex] || QUERY_PARAM_PATTERNS[0];
  // scan on mask (cùng độ dài) nên param nằm in comment/string (already thành whitespace) will not khớp
  const cleanSql = maskCommentsAndStrings(sql);

  const matches: string[] = [];

  if (patternObj.isPositional) {
    let count = 0;
    const re = new RegExp(patternObj.regex.source, 'g');
    while (re.exec(cleanSql) !== null) {
      count++;
      matches.push(positionalParamKey(count));
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

// Kiểu dữ liệu user select for mỗi tham số in QueryParamsModal.
export type QueryParamType = 'auto' | 'text' | 'number' | 'boolean' | 'null';

// Giá trị + kiểu of một tham số (do modal thu thập).
export interface TypedParamValue {
  value: string;
  type: QueryParamType;
}

/**
 * Ép giá trị string user nhập sang giá trị JSON đúng kiểu to bind at tầng driver.
 * 'auto' tự suy luận; các kiểu còn lại tôn trọng lựa select of user.
 */
export function resolveParamValue(raw: string, type: QueryParamType): string | number | boolean | null {
  switch (type) {
    case 'null':
      return null;
    case 'text':
      return raw;
    case 'boolean':
      return /^(true|1|yes|t|y)$/i.test(raw.trim());
    case 'number': {
      const n = Number(raw.trim());
      return Number.isFinite(n) ? n : raw; // not parse is -> giữ string to DB tự báo error rõ ràng
    }
    case 'auto':
    default: {
      const t = raw.trim();
      if (t === '') return null;
      if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
      // Số nguyên: tránh mất số 0 at đầu (vd mã bưu chính '01234') -> giữ string if có 0 đứng đầu
      if (/^-?[1-9]\d*$/.test(t) || t === '0') {
        const n = Number(t);
        if (Number.isSafeInteger(n)) return n;
      }
      if (/^-?\d*\.\d+$/.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n)) return n;
      }
      return raw;
    }
  }
}

/**
 * Chuyển SQL có placeholder (:name, %name%, ?, ${name}) thành SQL with placeholder NATIVE of driver
 * (`?` for SQLite/MySQL, `$1..$n` for Postgres) kèm mảng giá trị already ép kiểu theo đúng thứ tự bind.
 *
 * Mỗi lần xuất hiện of một tham số -> một placeholder + một giá trị (tham số lặp lại is bind lặp lại),
 * đảm bảo ngữ nghĩa đồng nhất on cả 3 driver. Placeholder nằm in string/comment is preserve.
 *
 * Đây is điểm mấu chốt to not nội suy giá trị ando SQL (chống SQL injection) — giá trị is send
 * riêng for backend to bind at tầng driver.
 */
export function buildParameterizedSql(
  sql: string,
  patternIndex: number,
  valuesMap: Record<string, TypedParamValue>,
  dialect: string
): { sql: string; values: (string | number | boolean | null)[] } {
  const patternObj = QUERY_PARAM_PATTERNS[patternIndex] || QUERY_PARAM_PATTERNS[0];
  const isPg = dialect === 'postgres';
  const mask = maskCommentsAndStrings(sql);
  const isMasked = (offset: number) => mask[offset] !== sql[offset];
  const values: (string | number | boolean | null)[] = [];

  const pushValue = (key: string, altKey?: string) => {
    const entry = valuesMap[key] ?? (altKey ? valuesMap[altKey] : undefined);
    values.push(resolveParamValue(entry?.value ?? '', entry?.type ?? 'auto'));
    // Postgres đánh số $1..$n theo thứ tự bind; SQLite/MySQL dùng `?`.
    return isPg ? `$${values.length}` : '?';
  };

  if (patternObj.isPositional) {
    let index = 0;
    const outSql = sql.replace(/\?/g, (m, offset: number) => {
      if (isMasked(offset)) return m; // ? trong string/comment -> preserve
      index++;
      return pushValue(positionalParamKey(index));
    });
    return { sql: outSql, values };
  }

  const re = new RegExp(patternObj.regex.source, 'g');
  const outSql = sql.replace(re, (m, p1, offset: number) => {
    if (isMasked(offset)) return m;
    return pushValue(m, p1);
  });
  return { sql: outSql, values };
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

  // Mask cùng độ dài with sql: một match at position `offset` nằm in comment/string
  // when and chỉ when character đầu of nó is thay khác đi in mask (thành whitespace).
  const mask = maskCommentsAndStrings(sql);
  const isMasked = (offset: number) => mask[offset] !== sql[offset];

  if (patternObj.isPositional) {
    let index = 0;
    return sql.replace(/\?/g, (match, offset) => {
      if (isMasked(offset)) return match; // ? nằm in string/comment -> preserve
      index++;
      const key = positionalParamKey(index);
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
