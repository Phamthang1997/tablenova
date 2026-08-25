// Document outline (breadcrumbs + Outline tree panel) and per-statement folding.
//
// Sourced from `splitStatements()` which identifies statement boundaries including $ blocks,
// MySQL custom DELIMITERs, and trigger bodies.
// Display labels produced by `describeStatement()`.
//
// Essential for multi-hundred line migration/dump scripts where default indentation-based
// folding is ineffective for SQL.

import type * as monaco from 'monaco-editor';
import { describeStatement, splitStatements, type StatementKind } from './statements';
import { LANG_IDS } from './sqlLanguage';

/**
 * The icon for each kind of statement. This mapping is **only** for picking an icon — nothing else
 * reads it, so do not read any further meaning into `select` being a `Method`.
 */
function symbolKindOf(kind: StatementKind, m: typeof monaco): monaco.languages.SymbolKind {
  switch (kind) {
    case 'select': return m.languages.SymbolKind.Method;
    case 'write': return m.languages.SymbolKind.Function;
    case 'ddl': return m.languages.SymbolKind.Class;
    default: return m.languages.SymbolKind.Variable;
  }
}

/**
 * Registers the document-symbol and folding providers for all three dialects.
 *
 * The anti-double-registration flag lives on `window` for the same reason as in the other
 * providers: a Vite HMR reload resets module state, and the provider gets registered twice.
 */
export function registerSqlOutline(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlOutlineDisposables)) {
    for (const d of w.__sqlOutlineDisposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
  }

  const symbols: monaco.languages.DocumentSymbolProvider = {
    provideDocumentSymbols(model) {
      const text = model.getValue();
      return splitStatements(text).map((stmt) => {
        const start = model.getPositionAt(stmt.start);
        const end = model.getPositionAt(stmt.end);
        const { kind, label } = describeStatement(stmt.text);
        const range = {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        };
        return {
          name: label,
          detail: '',
          kind: symbolKindOf(kind, monacoInstance),
          tags: [],
          range,
          // Moves cursor to statement start rather than selecting full range.
          
          selectionRange: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: start.lineNumber,
            endColumn: start.column,
          },
        };
      });
    },
  };

  const folding: monaco.languages.FoldingRangeProvider = {
    provideFoldingRanges(model) {
      const text = model.getValue();
      const ranges: monaco.languages.FoldingRange[] = [];
      for (const stmt of splitStatements(text)) {
        const start = model.getPositionAt(stmt.start).lineNumber;
        const end = model.getPositionAt(stmt.end).lineNumber;
        // Single-line statements cannot be folded; omitted from folding ranges.
        if (end > start) ranges.push({ start, end });
      }
      return ranges;
    },
  };

  w.__sqlOutlineDisposables = LANG_IDS.flatMap((lang) => [
    monacoInstance.languages.registerDocumentSymbolProvider(lang, symbols),
    monacoInstance.languages.registerFoldingRangeProvider(lang, folding),
  ]);
}
