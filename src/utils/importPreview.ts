/**
 * The helpers behind the "preview" part of the import flows (DataGrid and Sidebar > Import data).
 * For display only — never used to generate DDL or the statements that actually run.
 */

import i18n from '../i18n';

/** The union of every row's column names (a CSV/JSON row may be missing some). */
export function collectColumns(rows: any[], sample = 200): string[] {
  const cols: string[] = [];
  for (const r of rows.slice(0, sample)) {
    for (const k of Object.keys(r || {})) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
}

/** Infers a column's data type from at most the first 100 rows, returning an already-translated label. */
export function inferColType(rows: any[], col: string): string {
  let seen = 0, num = 0, bool = 0, date = 0, json = 0, hasDecimal = false;
  for (const r of rows.slice(0, 100)) {
    const v = r?.[col];
    if (v === null || v === undefined || v === '') continue;
    seen++;
    if (typeof v === 'object') { json++; continue; }
    const s = String(v).trim();
    if (typeof v === 'boolean' || /^(true|false)$/i.test(s)) { bool++; continue; }
    if (/^-?\d+(\.\d+)?$/.test(s)) { num++; if (s.includes('.')) hasDecimal = true; continue; }
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.test(s)) { date++; continue; }
    if (/^[[{].*[\]}]$/.test(s)) { json++; continue; }
  }
  if (seen === 0) return i18n.t('errors.inferEmpty');
  if (num === seen) return hasDecimal ? i18n.t('errors.inferFloat') : i18n.t('errors.inferInteger');
  if (bool === seen) return i18n.t('errors.inferBoolean');
  if (date === seen) return i18n.t('errors.inferDateTime');
  if (json === seen) return i18n.t('errors.inferJson');
  return i18n.t('errors.inferString');
}
