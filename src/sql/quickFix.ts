// Quick Fix (bóng đèn / Ctrl+. ) cho các chẩn đoán của `inspection.ts`.
//
// Toàn bộ phần "sửa cái gì thành cái gì" đã được `inspectSqlText()` tính sẵn vào `issue.fix`
// (xem `QuickFixData`). File này cố ý chỉ còn phần dán vào Monaco: đổi `fix` thành `CodeAction`.
// Nhờ vậy phần có thể sai — chọn ứng viên, xác định vùng thay — nằm trong một hàm thuần đã có
// test, còn ở đây không có logic nào để mà kiểm thử.
//
// Không đọc `context.markers`: marker chỉ mang chuỗi đã dịch, mà suy ngược tên định danh từ câu
// chữ thì hỏng ngay khi đổi ngôn ngữ. Chạy lại `inspectSqlText` trên văn bản hiện tại rẻ hơn
// nhiều so với việc phải giữ đồng bộ một bảng trạng thái song song với model.
import type * as monaco from 'monaco-editor';
import { inspectSqlText } from './inspection';
import { LANG_IDS } from './sqlLanguage';
import i18n from '../i18n';

/** Một khoảng dòng/cột, đủ để so giao nhau. */
interface Span {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Vùng chẩn đoán có chạm vùng Monaco đang hỏi không (con trỏ, hoặc phần bôi đen)?
 *
 * So theo vùng **gạch chân**, không phải vùng sẽ thay. Hai vùng đó khác nhau ở lỗi cột: gạch chân
 * phủ `u.nmae` còn chỗ thay chỉ là `nmae`. Người dùng nhìn thấy đường gạch nên sẽ đặt con trỏ vào
 * bất kỳ đâu trong nó — nếu chỉ nhận vùng thay thì đứng ở `u` bấm Quick Fix sẽ không ra gì, và
 * điều đó không phân biệt được với "tính năng hỏng".
 */
function intersects(span: Span, range: monaco.IRange): boolean {
  if (span.endLine < range.startLineNumber || span.startLine > range.endLineNumber) return false;
  if (span.endLine === range.startLineNumber && span.endColumn < range.startColumn) return false;
  if (span.startLine === range.endLineNumber && span.startColumn > range.endColumn) return false;
  return true;
}

/**
 * Đăng ký code action provider cho cả 3 dialect.
 *
 * Cờ chống-đăng-ký-trùng nằm trên `window` chứ không phải biến module, cùng lý do như hover:
 * Vite HMR nạp lại module thì biến module reset và provider bị đăng ký thêm lần nữa, khiến mỗi
 * Quick Fix hiện thành hai dòng giống hệt.
 */
export function registerSqlQuickFix(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlQuickFixDisposables)) {
    for (const d of w.__sqlQuickFixDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
    }
  }

  const provider: monaco.languages.CodeActionProvider = {
    provideCodeActions(model, range) {
      if (model.isDisposed()) return { actions: [], dispose: () => {} };

      const actions: monaco.languages.CodeAction[] = [];
      for (const issue of inspectSqlText(model.getValue())) {
        const fix = issue.fix;
        if (!fix || !intersects(issue, range)) continue;

        for (const candidate of fix.candidates) {
          actions.push({
            title: i18n.t('sqlEditor.quickFixReplaceWith', { n: candidate }),
            kind: 'quickfix',
            edit: {
              edits: [{
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: {
                  range: {
                    startLineNumber: fix.startLine,
                    startColumn: fix.startColumn,
                    endLineNumber: fix.endLine,
                    endColumn: fix.endColumn,
                  },
                  text: candidate,
                },
              }],
            },
          });
        }
      }

      // Ứng viên đầu tiên là gần nhất, đánh dấu `isPreferred` để Ctrl+. + Enter chọn luôn nó.
      if (actions.length) actions[0].isPreferred = true;
      return { actions, dispose: () => {} };
    },
  };

  w.__sqlQuickFixDisposables = LANG_IDS.map((lang) =>
    monacoInstance.languages.registerCodeActionProvider(lang, provider, {
      providedCodeActionKinds: ['quickfix'],
    }),
  );
}
