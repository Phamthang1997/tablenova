// Outline (breadcrumb + panel Outline) và gập từng câu lệnh.
//
// Cả hai đọc cùng một nguồn: `splitStatements()` đã biết ranh giới câu lệnh — kể cả những chỗ
// khó như `$$…$$` của Postgres, `DELIMITER` của MySQL và thân trigger — nên ở đây không có
// bộ tách thứ hai để lệch. Tên hiển thị do `describeStatement()` đặt (thuần văn bản, có test).
//
// Vì sao đáng làm: một script nhập/khôi phục dài vài trăm dòng thì thanh cuộn là cách duy nhất
// để đi lại, và Monaco tự gập theo thụt lề — mà SQL thì gần như không thụt lề, nên chức năng
// gập mặc định gần như vô dụng.
import type * as monaco from 'monaco-editor';
import { describeStatement, splitStatements, type StatementKind } from './statements';
import { LANG_IDS } from './sqlLanguage';

/**
 * Biểu tượng cho từng loại câu lệnh. Ánh xạ này **chỉ** để chọn icon — không có quyết định nào
 * khác đọc nó, nên đừng đọc ý nghĩa gì thêm vào việc `select` là `Method`.
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
 * Đăng ký document symbol + folding cho cả 3 dialect.
 *
 * Cờ chống-đăng-ký-trùng nằm trên `window`, cùng lý do như các provider khác (Vite HMR nạp lại
 * module thì biến module reset và provider bị đăng ký chồng).
 */
export function registerSqlOutline(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlOutlineDisposables)) {
    for (const d of w.__sqlOutlineDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
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
          // Nhảy tới đầu câu lệnh chứ không bôi đen cả câu: click trong outline là để đi tới,
          // không phải để chọn.
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
        // Câu lệnh một dòng không có gì để gập; thêm vào chỉ tạo mũi tên gập bấm không ra gì.
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
