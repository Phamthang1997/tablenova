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
    // This label is rendered for the user. It has to be escaped as '\\w': in a JS string '\w' reads
    // as 'w' (the backslash is eaten), so the UI was showing ':[w.]' instead.
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
 * Returns a string of EQUAL LENGTH to `sql`, replacing characters inside comments (-- , /* * /)
 * or strings ('...', "...", `...`) with whitespace, preserving all other characters.
 * Preserves character offsets for accurate position matching.
 */
export function maskCommentsAndStrings(sql: string): string {
  if (!sql) return '';
  const n = sql.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // A line comment: -- … to the end of the line
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // A block comment: /* … */
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // Strings: ' " ` (handling the doubled '' escape inside a single-quoted string)
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
  // Scanned over the mask (same length), so a parameter inside a comment or string (now whitespace) cannot match
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

// The data type the user picks for each parameter in QueryParamsModal.
export type QueryParamType = 'auto' | 'text' | 'number' | 'boolean' | 'null';

// One parameter's value and type, as collected by the modal.
export interface TypedParamValue {
  value: string;
  type: QueryParamType;
}

/**
 * Coerces the string the user typed into a correctly typed JSON value for binding at the driver level.
 * 'auto' infers it; every other type honours what the user chose.
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
      return Number.isFinite(n) ? n : raw; // unparseable -> keep the string so the DB reports a clear error itself
    }
    case 'auto':
    default: {
      const t = raw.trim();
      if (t === '') return null;
      if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
      // Integers: a leading zero must not be lost (a postcode like '01234') -> kept as a string when one is present
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
 * Turns SQL with placeholders (:name, %name%, ?, ${name}) into SQL with the driver's NATIVE ones
 * (`?` for SQLite/MySQL, `$1..$n` for Postgres) plus an array of coerced values in bind order.
 *
 * Each occurrence of a parameter -> one placeholder and one value (a repeated parameter is bound
 * repeatedly), which keeps the semantics identical across all three drivers. Placeholders inside
 * strings or comments are left untouched.
 *
 * This is the crux of NEVER interpolating values into SQL (which is what stops SQL injection) — the
 * values are sent separately for the backend to bind at the driver level.
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
    // Postgres numbers $1..$n in bind order; SQLite and MySQL use `?`.
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

  // The mask has the same length as the sql: a match at `offset` is inside a comment or string if and
  // only if its first character was replaced in the mask (turned into whitespace).
  const mask = maskCommentsAndStrings(sql);
  const isMasked = (offset: number) => mask[offset] !== sql[offset];

  if (patternObj.isPositional) {
    let index = 0;
    return sql.replace(/\?/g, (match, offset) => {
      if (isMasked(offset)) return match; // the ? sits inside a string or comment -> left alone
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
