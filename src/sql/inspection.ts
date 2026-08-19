import type * as monaco from 'monaco-editor';
import { dbIndexRegistry } from './dbIndexRegistry';
import {
  collectCteNames, collectSelectListRefs, collectTableRefs, resolveAliases, maskForSplit,
  splitStatements,
} from './statements';
import i18n from '../i18n';

/**
 * Dữ liệu để dựng Quick Fix, tính sẵn ở đây thay vì để code action tự suy ra.
 *
 * Lý do tách hẳn ra: `message` đã đi qua i18n, nên đọc ngược tên định danh từ câu chữ là bám vào
 * bản dịch — đúng cái mà quy ước "không rẽ nhánh theo văn bản hiển thị" cấm. Chỗ duy nhất biết
 * chắc cần thay gì và thay bằng gì là chỗ phát hiện ra lỗi.
 */
export interface QuickFixData {
  /** Vùng sẽ thay. Có thể HẸP HƠN vùng gạch chân: `u.nmae` gạch cả cụm nhưng chỉ thay `nmae`. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  /** Tên thay thế, đã xếp theo độ gần. */
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
  // Tên CTE trông y hệt tên bảng ở `FROM`/`JOIN` nhưng không có trong catalog. Gom trước để
  // vòng dưới bỏ qua, nếu không mọi câu `WITH … SELECT * FROM <cte>` đều bị báo đỏ oan.
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
        // `findSimilarColumns` đã tính sẵn gợi ý; trước đây chuỗi nối nó vào chỉ có ở nhánh
        // tiếng Việt, nên người dùng EN/JA thấy lỗi mà không thấy tên cột đúng.
        const suggestions = dbIndexRegistry.findSimilarColumns(colName, targetTbl);
        const hint =
          suggestions.length > 0
            ? i18n.t('sqlEditor.inspectDidYouMean', { n: suggestions.join(', ') })
            : '';

        // Gạch chân cả `alias.cột` cho dễ thấy, nhưng Quick Fix chỉ được đụng vào phần tên cột —
        // regex khớp không cho phép khoảng trắng nên vị trí dấu chấm là xác định.
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

  // 3. Cột KHÔNG có tiền tố trong danh sách SELECT — `SELECT ids FROM test`.
  //
  // Chạy theo TỪNG câu lệnh chứ không trên cả buffer: phạm vi bảng của câu này không nói gì về
  // câu kế bên. Và chỉ chạy khi biết chắc toàn bộ phạm vi — thiếu một mảnh nào thì im lặng, vì
  // một cảnh báo sai ở đây dạy người dùng bỏ qua mọi đường gạch chân, kể cả đường đúng.
  for (const stmt of splitStatements(text)) {
    const refs = collectTableRefs(stmt.text);
    if (!refs.length) continue;                              // không có FROM -> không có phạm vi
    if (collectCteNames(stmt.text).size) continue;           // cột của CTE không nằm trong catalog
    // Truy vấn con trong FROM/JOIN: `collectTableRefs` chui vào trong ngoặc và báo về bảng của
    // truy vấn con, nên "phạm vi" thu được là của tầng khác — `SELECT x FROM (SELECT id FROM
    // users) t` trông như thể `x` phải là cột của `users`. Không đủ hiểu thì không nói gì.
    if (/\b(?:from|join)\s*\(/i.test(maskForSplit(stmt.text))) continue;

    const scope = Array.from(new Set(refs.map((r) => r.table.replace(/[`"[\]]/g, ''))));
    if (!scope.every((tbl) => dbIndexRegistry.hasTable(tbl))) continue; // một bảng lạ -> bó tay

    const known = new Set<string>();
    for (const tbl of scope) {
      for (const col of dbIndexRegistry.getTableColumns(tbl)) known.add(col.name.toLowerCase());
    }
    // Alias của bảng cũng hợp lệ ở vị trí này (`SELECT t FROM test t` hiếm nhưng đúng cú pháp).
    const aliasNames = new Set(resolveAliases(stmt.text).keys());

    for (const ref of collectSelectListRefs(stmt.text)) {
      const lower = ref.name.toLowerCase();
      if (known.has(lower) || aliasNames.has(lower)) continue;

      const startPos = getPosition(stmt.start + ref.offset);
      const endPos = getPosition(stmt.start + ref.offset + ref.name.length);
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
