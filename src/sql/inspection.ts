import type * as monaco from 'monaco-editor';
import { dbIndexRegistry } from './dbIndexRegistry';
import { collectTableRefs, resolveAliases, maskForSplit } from './statements';
import { currentLanguage } from '../i18n';

export interface DiagnosticIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

const DUMMY_TABLES = new Set(['dual', 'generate_series', 'unnest', 'json_each', 'json_tree', 'information_schema', 'pg_catalog']);

/**
 * Inspects a raw SQL string or Monaco editor text and returns diagnostic issues.
 */
export function inspectSqlText(text: string): DiagnosticIssue[] {
  if (!text || !dbIndexRegistry.isReady()) return [];

  const issues: DiagnosticIssue[] = [];
  const lines = text.split('\n');

  // Compute offset -> { line, col } helper
  const getPosition = (offset: number) => {
    let currentOffset = 0;
    for (let l = 0; l < lines.length; l++) {
      const lineLen = lines[l].length + 1; // +1 for \n
      if (offset < currentOffset + lineLen) {
        return { line: l + 1, col: Math.max(1, offset - currentOffset + 1) };
      }
      currentOffset += lineLen;
    }
    return { line: lines.length, col: Math.max(1, lines[lines.length - 1].length + 1) };
  };

  const maskedText = maskForSplit(text);
  const lang = currentLanguage();

  // 1. Table Reference Validation
  const tableRefs = collectTableRefs(text);
  const aliasMap = resolveAliases(text);

  for (const ref of tableRefs) {
    const cleanTbl = ref.table.replace(/[`"[\]]/g, '');
    if (!cleanTbl || DUMMY_TABLES.has(cleanTbl.toLowerCase())) continue;

    if (!dbIndexRegistry.hasTable(cleanTbl)) {
      // Find position of table in text
      const regex = new RegExp(`\\b${cleanTbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let match: RegExpExecArray | null;

      while ((match = regex.exec(maskedText)) !== null) {
        const startPos = getPosition(match.index);
        const endPos = getPosition(match.index + cleanTbl.length);

        const msg =
          lang === 'vi'
            ? `Bảng '${cleanTbl}' không tồn tại trong CSDL`
            : lang === 'ja'
            ? `テーブル '${cleanTbl}' は存在しません`
            : `Table '${cleanTbl}' does not exist in schema`;

        issues.push({
          severity: 'error',
          message: msg,
          startLine: startPos.line,
          startColumn: startPos.col,
          endLine: endPos.line,
          endColumn: endPos.col,
        });
      }
    }
  }

  // 2. Qualified Column Reference Validation (alias.column)
  const qualifiedColRegex = /\b([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)\b/g;
  let colMatch: RegExpExecArray | null;

  while ((colMatch = qualifiedColRegex.exec(maskedText)) !== null) {
    const aliasOrTbl = colMatch[1];
    const colName = colMatch[2];

    const targetTbl = aliasMap.get(aliasOrTbl.toLowerCase());
    if (targetTbl && dbIndexRegistry.hasTable(targetTbl)) {
      if (!dbIndexRegistry.hasColumn(targetTbl, colName)) {
        const fullMatch = colMatch[0];
        const matchOffset = colMatch.index;
        const startPos = getPosition(matchOffset);
        const endPos = getPosition(matchOffset + fullMatch.length);

        const realTbl = dbIndexRegistry.getRealTableName(targetTbl) || targetTbl;
        const suggestions = dbIndexRegistry.findSimilarColumns(colName, targetTbl);
        const hint = suggestions.length > 0 ? ` (Gợi ý: ${suggestions.join(', ')})` : '';

        const msg =
          lang === 'vi'
            ? `Cột '${colName}' không tồn tại trong bảng '${realTbl}'${hint}`
            : lang === 'ja'
            ? `列 '${colName}' はテーブル '${realTbl}' に存在しません`
            : `Column '${colName}' does not exist in table '${realTbl}'`;

        issues.push({
          severity: 'warning',
          message: msg,
          startLine: startPos.line,
          startColumn: startPos.col,
          endLine: endPos.line,
          endColumn: endPos.col,
        });
      }
    }
  }

  return issues;
}

/**
 * Runs inspection on a Monaco editor model and applies model markers (squiggly lines).
 */
export function runMonacoInspection(
  monacoInstance: typeof monaco,
  model: monaco.editor.ITextModel
): void {
  if (!model || model.isDisposed()) return;

  const text = model.getValue();
  const issues = inspectSqlText(text);

  const markers: monaco.editor.IMarkerData[] = issues.map((issue) => ({
    severity:
      issue.severity === 'error'
        ? monacoInstance.MarkerSeverity.Error
        : monacoInstance.MarkerSeverity.Warning,
    message: issue.message,
    startLineNumber: issue.startLine,
    startColumn: issue.startColumn,
    endLineNumber: issue.endLine,
    endColumn: issue.endColumn,
    source: 'TableNova SQL Inspection',
  }));

  monacoInstance.editor.setModelMarkers(model, 'sql-inspector', markers);
}

// Debounce map for Monaco editor models
const debounceTimers = new Map<string, number>();

/**
 * Attaches real-time background inspection to a Monaco Editor instance.
 */
export function attachEditorInspection(
  monacoInstance: typeof monaco,
  editor: monaco.editor.ICodeEditor
): () => void {
  const model = editor.getModel();
  if (!model) return () => {};

  const modelId = model.uri.toString();

  const scheduleInspect = () => {
    if (debounceTimers.has(modelId)) {
      window.clearTimeout(debounceTimers.get(modelId));
    }
    const timer = window.setTimeout(() => {
      runMonacoInspection(monacoInstance, model);
    }, 300);
    debounceTimers.set(modelId, timer);
  };

  // Run initial inspection
  void dbIndexRegistry.buildIndex().then(() => {
    scheduleInspect();
  });

  const disposable = model.onDidChangeContent(() => {
    scheduleInspect();
  });

  return () => {
    disposable.dispose();
    if (debounceTimers.has(modelId)) {
      window.clearTimeout(debounceTimers.get(modelId));
      debounceTimers.delete(modelId);
    }
  };
}
