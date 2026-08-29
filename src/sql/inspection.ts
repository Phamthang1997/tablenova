import type * as monaco from 'monaco-editor';
import { dbIndexRegistry } from './dbIndexRegistry';
import {
  collectCteNames, collectSelectListRefs, collectTableRefs, groupByRefs, hasAggregate,
  resolveAliases, maskForSplit, selectListItems, splitStatements,
} from './statements';
import { typeBase, typeFamily } from '../utils/columnType';
import i18n from '../i18n';

/**
 * The data a Quick Fix is built from, computed here instead of left for the code action to infer.
 *
 * Why it is split out at all: `message` has been through i18n, so recovering an identifier name from
 * its wording would lean on the translation — exactly what the "never branch on user-facing text"
 * rule forbids. The only place that knows for certain what to replace and what to replace it with is
 * the place that found the problem.
 */
export interface QuickFixData {
  /** Replacement range. Can be NARROWER than diagnostic squiggly: `u.nmae` underlines both but replaces `nmae`. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** Replacement candidates ranked by similarity. */
  candidates: string[];
}

export interface DiagnosticIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  fix?: QuickFixData;
}

const DUMMY_TABLES = new Set(['dual', 'generate_series', 'unnest', 'json_each', 'json_tree', 'information_schema', 'pg_catalog']);

/**
 * The Monaco language id of the buffer being edited (`mysql` | `pgsql` | `genericsql`).
 *
 * Used only for checks whose **answer depends on the dialect**. Left empty, those checks do not run
 * rather than assuming a default — assuming wrong means underlining SQL the real server accepts.
 */
export type SqlDialectId = string | undefined;

/** Dialects treating ambiguous columns as hard errors (Postgres/MySQL vs SQLite). */
const AMBIGUITY_IS_ERROR = new Set(['mysql', 'pgsql']);

/**
 * Inspects a raw SQL string or Monaco editor text and returns diagnostic issues.
 */
export function inspectSqlText(text: string, dialect?: SqlDialectId): DiagnosticIssue[] {
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
  // CTE names appear like physical tables in FROM/JOIN but lack catalog entries; gathered beforehand.
  
  const cteNames = collectCteNames(text);

  // 1. Table Reference Validation
  const tableRefs = collectTableRefs(text);
  const aliasMap = resolveAliases(text);

  for (const ref of tableRefs) {
    const cleanTbl = ref.table.replace(/[`"[\]]/g, '');
    const lower = cleanTbl.toLowerCase();
    if (!cleanTbl || DUMMY_TABLES.has(lower) || cteNames.has(lower)) continue;

    if (!dbIndexRegistry.hasTable(cleanTbl)) {
      // Find position of table in text
      const regex = new RegExp(`\\b${cleanTbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      let match: RegExpExecArray | null;

      while ((match = regex.exec(maskedText)) !== null) {
        const startPos = getPosition(match.index);
        const endPos = getPosition(match.index + cleanTbl.length);

        const similar = dbIndexRegistry.findSimilarTables(cleanTbl);
        issues.push({
          severity: 'error',
          message: i18n.t('sqlEditor.inspectTableNotExist', { table: cleanTbl }),
          fix: similar.length
            ? {
              startLine: startPos.line,
              startColumn: startPos.col,
              endLine: endPos.line,
              endColumn: endPos.col,
              candidates: similar,
            }
            : undefined,
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
        // `findSimilarColumns` pre-computes suggestions for all locales.
        
        const suggestions = dbIndexRegistry.findSimilarColumns(colName, targetTbl);
        const hint =
          suggestions.length > 0
            ? i18n.t('sqlEditor.inspectDidYouMean', { n: suggestions.join(', ') })
            : '';

        // Underlines `alias.column` for visibility while Quick Fix modifies only the column token.
        
        const colStart = getPosition(matchOffset + aliasOrTbl.length + 1);
        issues.push({
          severity: 'warning',
          message:
            i18n.t('sqlEditor.inspectColumnNotExist', { column: colName, table: realTbl }) + hint,
          fix: suggestions.length
            ? {
              startLine: colStart.line,
              startColumn: colStart.col,
              endLine: colStart.line,
              endColumn: colStart.col + colName.length,
              candidates: suggestions,
            }
            : undefined,
          startLine: startPos.line,
          startColumn: startPos.col,
          endLine: endPos.line,
          endColumn: endPos.col,
        });
      }
    }
  }

  // 3. Unqualified columns in SELECT list — `SELECT ids FROM test`.
  //
  // Evaluated per statement to isolate table scopes.
  
  
  for (const stmt of splitStatements(text)) {
    const refs = collectTableRefs(stmt.text);
    if (!refs.length) continue;                              // no FROM clause -> unresolvable scope
    if (collectCteNames(stmt.text).size) continue;           // CTE columns are outside catalog
    // Subqueries in FROM/JOIN: nested scopes omitted to prevent false squigglies.
    
    
    const stmtMasked = maskForSplit(stmt.text);
    if (/\b(?:from|join)\s*\(/i.test(stmtMasked)) continue;

    const scope = Array.from(new Set(refs.map((r) => r.table.replace(/[`"[\]]/g, ''))));
    if (!scope.every((tbl) => dbIndexRegistry.hasTable(tbl))) continue; // unknown table -> skip

    // Column source ownership mapping to detect ambiguous columns.
    
    
    
    const ownersOf = new Map<string, string[]>();
    /** `alias.column` -> declared type. Keyed by source to differentiate column types across tables. */
    const typeOfCol = new Map<string, string>();
    const seenQualifier = new Set<string>();
    for (const ref of refs) {
      const tbl = ref.table.replace(/[`"[\]]/g, '');
      const qualifier = ref.alias || tbl;
      if (seenQualifier.has(qualifier.toLowerCase())) continue;
      seenQualifier.add(qualifier.toLowerCase());
      for (const col of dbIndexRegistry.getTableColumns(tbl)) {
        const key = col.name.toLowerCase();
        const list = ownersOf.get(key);
        if (list) list.push(qualifier);
        else ownersOf.set(key, [qualifier]);
        typeOfCol.set(`${qualifier.toLowerCase()}.${key}`, col.type);
      }
    }
    // Table alias is valid in this position (`SELECT t FROM test t`).
    const aliasNames = new Set(resolveAliases(stmt.text).keys());

    for (const ref of collectSelectListRefs(stmt.text)) {
      const lower = ref.name.toLowerCase();
      if (aliasNames.has(lower)) continue;
      const owners = ownersOf.get(lower);

      const startPos = getPosition(stmt.start + ref.offset);
      const endPos = getPosition(stmt.start + ref.offset + ref.name.length);

      // 3a. Multiple sources -> ambiguous. MySQL/Postgres reject; SQLite resolves to first match,
      // so suppressing for SQLite avoids false positives.
      
      if (owners && owners.length > 1) {
        if (!dialect || !AMBIGUITY_IS_ERROR.has(dialect)) continue;
        issues.push({
          severity: 'error',
          message: i18n.t('sqlEditor.inspectColumnAmbiguous', {
            column: ref.name,
            n: owners.join(', '),
          }),
          // Fix: qualify column identifier with candidate table sources.
          
          fix: {
            startLine: startPos.line,
            startColumn: startPos.col,
            endLine: endPos.line,
            endColumn: endPos.col,
            candidates: owners.map((q) => `${q}.${ref.name}`),
          },
          startLine: startPos.line,
          startColumn: startPos.col,
          endLine: endPos.line,
          endColumn: endPos.col,
        });
        continue;
      }

      if (owners) continue; // 3b. Single source -> valid

      const similar = Array.from(
        new Set(scope.flatMap((tbl) => dbIndexRegistry.findSimilarColumns(ref.name, tbl))),
      ).slice(0, 3);

      issues.push({
        severity: 'warning',
        message: i18n.t('sqlEditor.inspectColumnNotInScope', { column: ref.name }),
        fix: similar.length
          ? {
            startLine: startPos.line,
            startColumn: startPos.col,
            endLine: endPos.line,
            endColumn: endPos.col,
            candidates: similar,
          }
          : undefined,
        startLine: startPos.line,
        startColumn: startPos.col,
        endLine: endPos.line,
        endColumn: endPos.col,
      });
    }

    // 4. Type mismatch comparison — `WHERE int_col = 'abc'`.
    //
    // Catches clear errors across all 3 dialects without flagging implicit casts:
    //  - `int_col = '5'`: implicit type coercion is valid SQL;
    //  - `date_col = '2024-01-01'`: string literals are standard for dates;
    //  - `text_col = 5`: MySQL/SQLite allow this; omitted to avoid false alarms.
    
    const cmp = /([`"[]?[A-Za-z_]\w*[`"\]]?(?:\.[`"[]?[A-Za-z_]\w*[`"\]]?)?)\s*(?:=|<>|!=|>=|<=|<|>)\s*('(?:[^']|'')*')/g;
    let cm: RegExpExecArray | null;
    while ((cm = cmp.exec(stmt.text)) !== null) {
      // Left-hand expression must be real code, outside strings and comments.
      if (stmtMasked[cm.index] !== stmt.text[cm.index]) continue;

      const parts = cm[1].replace(/[`"[\]]/g, '').split('.');
      const colName = parts[parts.length - 1];
      const qualifier = parts.length > 1 ? parts[0] : null;

      let type: string | undefined;
      if (qualifier) {
        type = typeOfCol.get(`${qualifier.toLowerCase()}.${colName.toLowerCase()}`);
      } else {
        const owners = ownersOf.get(colName.toLowerCase());
        // Ambiguous column types across tables -> skip type comparison.
        if (owners?.length === 1) type = typeOfCol.get(`${owners[0].toLowerCase()}.${colName.toLowerCase()}`);
      }
      if (!type) continue;

      const family = typeFamily(type);
      const inner = cm[2].slice(1, -1).replace(/''/g, "'");
      const badNumber = family === 'number' && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(inner);
      // "Non-date literal" defined as having zero numeric digits to avoid false diagnostics.
      
      const badDate = family === 'date' && inner.length > 0 && !/\d/.test(inner);
      if (!badNumber && !badDate) continue;

      const startPos = getPosition(stmt.start + cm.index);
      const endPos = getPosition(stmt.start + cm.index + cm[0].length);
      issues.push({
        severity: 'warning',
        message: i18n.t('sqlEditor.inspectTypeMismatch', {
          column: colName,
          type: typeBase(type),
          value: inner,
        }),
        startLine: startPos.line,
        startColumn: startPos.col,
        endLine: endPos.line,
        endColumn: endPos.col,
      });
    }

    // 5. Non-aggregated SELECT column missing from GROUP BY clause.
    //
    // Rejected by Postgres and MySQL (ONLY_FULL_GROUP_BY); permitted in SQLite.
    
    const grouped = groupByRefs(stmt.text);
    if (grouped && grouped.length && dialect && AMBIGUITY_IS_ERROR.has(dialect)) {
      // Functionally dependent columns allowed when grouping by primary key.
      
      const groupsByKey = grouped.some((g) =>
        scope.some((tbl) => dbIndexRegistry.getColumn(tbl, g.name)?.isPrimaryKey));

      if (!groupsByKey) {
        const groupedNames = new Set(grouped.map((g) => g.name.toLowerCase()));
        const items = selectListItems(stmt.text);
        for (const ref of collectSelectListRefs(stmt.text)) {
          const lower = ref.name.toLowerCase();
          if (groupedNames.has(lower) || aliasNames.has(lower)) continue;
          if (!ownersOf.has(lower)) continue;   // unknown column -> handled by check 3

          const item = items.find((it) => ref.offset >= it.offset && ref.offset < it.offset + it.text.length);
          if (!item || hasAggregate(item.text)) continue;

          const startPos = getPosition(stmt.start + ref.offset);
          const endPos = getPosition(stmt.start + ref.offset + ref.name.length);
          issues.push({
            severity: 'error',
            message: i18n.t('sqlEditor.inspectNotGrouped', { column: ref.name }),
            startLine: startPos.line,
            startColumn: startPos.col,
            endLine: endPos.line,
            endColumn: endPos.col,
          });
        }
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
  // Dialect resolved from active editor model.
  const issues = inspectSqlText(text, model.getLanguageId());

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
