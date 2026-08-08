export interface RoutineParam {
  mode: 'IN' | 'OUT' | 'INOUT';
  name: string;
  type: string;
}

export function parseRoutineParameters(sql: string): RoutineParam[] {
  if (!sql) return [];
  // Match header: PROCEDURE / FUNCTION name(param1, param2...)
  const headerMatch = sql.match(/(?:PROCEDURE|FUNCTION)\s+[`"]?\w+[`"]?\s*\(([\s\S]*?)\)/i);
  if (!headerMatch || !headerMatch[1]) return [];

  const rawParams = headerMatch[1].trim();
  if (!rawParams) return [];

  const params: RoutineParam[] = [];
  // Split params by comma (simplistic top-level split)
  const tokens = rawParams.split(/,\s*(?![^()]*\))/);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Match mode, name, type: e.g. IN p_film_id INT, OUT p_count INT, p_id INT
    const m = trimmed.match(/^(INOUT|IN|OUT)?\s*[`"]?([A-Za-z0-9_]+)[`"]?\s+(.+)$/i);
    if (m) {
      params.push({
        mode: (m[1]?.toUpperCase() || 'IN') as 'IN' | 'OUT' | 'INOUT',
        name: m[2],
        type: m[3].trim(),
      });
    }
  }
  return params;
}

export function getDefaultValueForType(type: string): string {
  const t = (type || '').toUpperCase().trim();
  if (t.includes('DATE') || t.includes('TIME')) {
    const now = new Date();
    const iso = now.toISOString().slice(0, 19).replace('T', ' ');
    return t.includes('DATETIME') || t.includes('TIMESTAMP') || t.includes('TIME')
      ? iso
      : iso.slice(0, 10);
  }
  if (t.includes('CHAR') || t.includes('TEXT') || t.includes('CLOB') || t.includes('VARCHAR')) {
    return 'test';
  }
  if (t.includes('BOOL') || t.includes('BIT')) {
    return '1';
  }
  return '1';
}
