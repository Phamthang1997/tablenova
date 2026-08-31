// "Peek Definition" (Alt+F12): opens table DDL inline within an embedded editor peek widget
// without switching away from active query tab.
//
// Differs from Ctrl+Click / F12 which **opens a dedicated table tab** (`intellisense.ts` +
// `open-table-tab`). Two distinct user intents: inspecting schema/keys needs a glance (peek),
// while browsing data warrants a full tab switch.

//
// Monaco models definitions as uri positions. Database tables lack source files, so
// we construct virtual models with custom URIs holding DDL, reused per (connection, table)
// and refreshed on each peek to reflect recent ALTER statements.
import type * as monaco from 'monaco-editor';
import * as catalog from './catalog';
import { editorConnId } from './editorScope';
import { findTable } from './intellisense';
import { LANG_IDS } from './sqlLanguage';
import { dbHelper } from '../utils/dbHelper';

/**
 * DDL built from the cached catalog.
 *
 * Used only when the backend cannot return the real DDL (connection lost, or the dialect has no
 * such statement). Better to show an approximation — no worse than what hover already shows — than
 * to let Alt+F12 silently do nothing, because silence is indistinguishable from "the feature is
 * broken".
 */
function ddlFromCatalog(table: string, schema: ReturnType<typeof catalog.getCachedSchema>): string {
  const cols = schema?.columns || [];
  if (!cols.length) return `-- ${table}`;
  const body = cols.map((c) => {
    const parts = [`  ${c.name}`, c.type];
    if (c.nullable === false) parts.push('NOT NULL');
    if (c.isPrimaryKey) parts.push('PRIMARY KEY');
    return parts.join(' ');
  });
  const lines = [`CREATE TABLE ${table} (`, body.join(',\n'), ');'];
  for (const fk of schema?.foreignKeys || []) {
    lines.push(`-- FK: ${fk.column} -> ${fk.refTable}.${fk.refColumn}`);
  }
  return lines.join('\n');
}

/**
 * Registers definition provider across all 3 dialects.
 *
 * Anti-duplicate registration flag stored on `window` to prevent duplicate providers across Vite HMR.
 */
export function registerSqlPeekDefinition(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlDefinitionDisposables)) {
    for (const d of w.__sqlDefinitionDisposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
  }

  const provider: monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const table = await findTable(word.word);
      if (!table) return null;

      const connId = editorConnId();
      let text: string | null = null;
      try {
        const res = await dbHelper.getTableDefinition(connId, table.name);
        if (res.success && res.sql) text = res.sql;
      } catch { /* fall back to catalog-generated DDL */ }
      if (!text) text = ddlFromCatalog(table.name, catalog.getCachedSchema(connId, table.name));

      // URI includes connId: identical table name `users` across two connections represents distinct definitions.
      
      const uri = monacoInstance.Uri.parse(
        `tablegrid://table/${encodeURIComponent(connId)}/${encodeURIComponent(table.name)}.sql`,
      );
      const existing = monacoInstance.editor.getModel(uri);
      if (existing) {
        if (existing.getValue() !== text) existing.setValue(text);
      } else {
        monacoInstance.editor.createModel(text, model.getLanguageId(), uri);
      }

      return { uri, range: new monacoInstance.Range(1, 1, 1, 1) };
    },
  };

  w.__sqlDefinitionDisposables = LANG_IDS.map((lang) =>
    monacoInstance.languages.registerDefinitionProvider(lang, provider),
  );
}
