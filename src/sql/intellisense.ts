// Hover provider (column/type inspection) + "jump to table" (Ctrl+Click / F12).
// Data sourced from catalog cache (avoids backend calls on every hover).
import * as monaco from 'monaco-editor';
import * as catalog from './catalog';
import { editorConnId } from './editorScope';
import { LANG_IDS } from './sqlLanguage';
import { statementAt, resolveAliases } from './statements';
import { getDoc, formatDocMarkdown } from '../utils/docsService';
import i18n, { currentLanguage } from '../i18n';

/** Finds table by name (case-insensitive) from loaded cache only. */
export async function findTable(name: string): Promise<{ name: string; type: string } | null> {
  if (!name) return null;
  const bare = name.replace(/^[`"[]|[`"\]]$/g, '');
  const tables = await catalog.getTables(editorConnId());
  return tables.find(t => t.name.toLowerCase() === bare.toLowerCase()) || null;
}

/** Requests App to open table tab (App.tsx listens for this event). */
export function openTableTab(table: string, viewMode: 'data' | 'structure' = 'data'): void {
  window.dispatchEvent(new CustomEvent('open-table-tab', { detail: { table, viewMode } }));
}

// Hover markdown formatting. Technical keywords (`PK`, `NOT NULL`) are kept as standard SQL symbols.


function tableMarkdown(tableName: string, type: string, schema: Awaited<ReturnType<typeof catalog.getSchema>>): string {
  const kind = type === 'view' ? i18n.t('sqlEditor.hoverKindView') : i18n.t('sqlEditor.hoverKindTable');
  const lines: string[] = [`**${tableName}** · ${kind}`];
  const cols = schema?.columns || [];
  // 12-row limit: tables with many columns would otherwise overflow editor viewport.
  const MAX_COLS = 12;
  if (cols.length) {
    lines.push('', `| ${i18n.t('sqlEditor.hoverColHeader')} | ${i18n.t('sqlEditor.hoverTypeHeader')} |`, '| --- | --- |');
    for (const c of cols.slice(0, MAX_COLS)) {
      const badges = [c.isPrimaryKey ? 'PK' : '', c.nullable === false ? 'NOT NULL' : ''].filter(Boolean).join(', ');
      lines.push(`| ${c.name}${c.isPrimaryKey ? ' 🔑' : ''} | ${c.type}${badges ? ` · ${badges}` : ''} |`);
    }
    if (cols.length > MAX_COLS) {
      lines.push(`| _${i18n.t('sqlEditor.hoverMoreColumns', { n: cols.length - MAX_COLS })}_ | |`);
    }
  }
  const fks = schema?.foreignKeys || [];
  if (fks.length) {
    lines.push('', `**${i18n.t('sqlEditor.hoverForeignKeys')}**`);
    for (const fk of fks.slice(0, 5)) lines.push(`- \`${fk.column}\` → \`${fk.refTable}.${fk.refColumn}\``);
    if (fks.length > 5) lines.push(`- _${i18n.t('sqlEditor.hoverMoreForeignKeys', { n: fks.length - 5 })}_`);
  }
  lines.push('', `_${i18n.t('sqlEditor.hoverOpenTable')}_`);
  return lines.join('\n');
}

function columnMarkdown(colName: string, owners: { table: string; type: string; isPrimaryKey?: boolean; nullable?: boolean }[]): string {
  const lines: string[] = [`**${colName}** · ${i18n.t('sqlEditor.hoverKindColumn')}`];
  for (const o of owners.slice(0, 6)) {
    const badges = [o.isPrimaryKey ? 'PK' : '', o.nullable === false ? 'NOT NULL' : ''].filter(Boolean).join(', ');
    lines.push('', `\`${o.table}.${colName}\` — ${o.type}${badges ? ` · ${badges}` : ''}`);
  }
  if (owners.length > 6) lines.push('', `_${i18n.t('sqlEditor.hoverMoreTables', { n: owners.length - 6 })}_`);
  return lines.join('\n');
}

/**
 * Registers hover provider for all 3 SQL dialects.
 * Anti-duplicate flag stored on `window` to prevent duplicate providers during Vite HMR.
 
 */
export function setupSqlHover(): void {
  const w = window as any;
  // Disposes provider from previous HMR cycle during development
  if (Array.isArray(w.__sqlHoverDisposables)) {
    for (const d of w.__sqlHoverDisposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
  }

  const provider: monaco.languages.HoverProvider = {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const name = word.word;

      // 1) Matches table/view name?
      const table = await findTable(name);
      if (table) {
        const schema = await catalog.getSchema(editorConnId(), table.name);
        return { range, contents: [{ value: tableMarkdown(table.name, table.type, schema) }] };
      }

      // 1.5) Matches function or SQL command? (lacks dot prefix)
      const lineStart = model.getValueInRange({
        startLineNumber: position.lineNumber, startColumn: 1,
        endLineNumber: position.lineNumber, endColumn: word.startColumn,
      });
      const dot = lineStart.match(/([A-Za-z_]\w*)\s*\.\s*$/);
      const prefix = dot ? dot[1].toLowerCase() : null;

      if (!prefix) {
        const langId = model.getLanguageId();
        const docEntry = getDoc(name, langId);
        if (docEntry) {
          return { range, contents: [{ value: formatDocMarkdown(docEntry, currentLanguage()) }] };
        }
      }

      // 2) Matches column — prioritizes table inferred from "alias." prefix then tables in statement
      const text = model.getValue();
      const stmt = statementAt(text, model.getOffsetAt(position));
      const aliases = stmt ? resolveAliases(stmt.text) : new Map<string, string>();

      let candidates: string[];
      // cacheOnly: when scanning ALL tables (query lacks FROM clause), reads from cache only
      // to avoid triggering hundreds of IPC calls on a single hover.
      let cacheOnly = false;
      if (prefix && aliases.has(prefix)) {
        candidates = [aliases.get(prefix)!];
      } else if (aliases.size) {
        candidates = Array.from(new Set(aliases.values()));
      } else {
        candidates = (await catalog.getTables(editorConnId())).map(t => t.name);
        cacheOnly = true;
      }

      const owners: { table: string; type: string; isPrimaryKey?: boolean; nullable?: boolean }[] = [];
      for (const t of candidates) {
        const schema = cacheOnly ? catalog.getCachedSchema(editorConnId(), t) : await catalog.getSchema(editorConnId(), t);
        const col = (schema?.columns || []).find(c => c.name.toLowerCase() === name.toLowerCase());
        if (col) owners.push({ table: t, type: col.type, isPrimaryKey: col.isPrimaryKey, nullable: col.nullable });
      }
      if (!owners.length) return null;
      return { range, contents: [{ value: columnMarkdown(name, owners) }] };
    },
  };

  w.__sqlHoverDisposables = LANG_IDS.map(lang => monaco.languages.registerHoverProvider(lang, provider));
}
