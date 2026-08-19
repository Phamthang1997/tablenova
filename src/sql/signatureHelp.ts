// Gợi ý tham số hàm (Monaco gọi là "parameter hints"): gõ `DATE_ADD(` thì hiện cú pháp và
// mô tả của từng tham số, và đánh dấu tham số đang gõ dở.
//
// Dữ liệu lấy nguyên từ `docsService` — cùng nguồn mà hover và completion đang dùng, nên không
// sinh thêm một bảng thứ hai để lệch. Phần duy nhất phải tự tính là "đang ở trong lời gọi nào,
// tham số thứ mấy", và phần đó nằm ở `enclosingCall()` trong `statements.ts` (thuần văn bản, có
// test) chứ không nằm ở đây.
import type * as monaco from 'monaco-editor';
import { enclosingCall } from './statements';
import { LANG_IDS } from './sqlLanguage';
import { getDoc, getDocSummary, getParamDesc } from '../utils/docsService';
import i18n, { currentLanguage } from '../i18n';

/**
 * Đăng ký signature help cho cả 3 dialect.
 *
 * Cờ chống-đăng-ký-trùng nằm trên `window` chứ không phải biến module, cùng lý do như hover và
 * quick fix: Vite HMR nạp lại module thì biến module reset và provider bị đăng ký chồng.
 */
export function registerSqlSignatureHelp(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlSignatureDisposables)) {
    for (const d of w.__sqlSignatureDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
    }
  }

  const provider: monaco.languages.SignatureHelpProvider = {
    // `,` để nhảy sang tham số kế; `)` retrigger để bảng ẩn đi khi lời gọi đã đóng.
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],

    provideSignatureHelp(model, position) {
      const call = enclosingCall(model.getValue(), model.getOffsetAt(position));
      if (!call) return null;

      const doc = getDoc(call.name, model.getLanguageId());
      if (!doc) return null;

      const lang = currentLanguage();
      const parameters = (doc.params || []).map((p) => ({
        // Nhãn dạng chuỗi: Monaco tự tìm nó trong `label` của chữ ký để tô đậm phần đang gõ.
        // Không khớp thì chỉ mất phần tô đậm, bảng vẫn hiện — nên không cần tính offset tay.
        label: p.name,
        documentation: {
          value: `${p.type ? `\`${p.type}\`${p.optional ? ` _(${i18n.t('sqlEditor.paramOptional')})_` : ''} — ` : ''}${getParamDesc(p, lang)}`,
        },
      }));

      return {
        value: {
          signatures: [{
            label: doc.syntax,
            documentation: { value: getDocSummary(doc, lang) },
            parameters,
          }],
          activeSignature: 0,
          // Kẹp lại: hàm biến thiên số tham số (`CONCAT(a, b, c, …)`) thì dấu phẩy thứ 5 vẫn
          // phải trỏ vào tham số cuối cùng được mô tả, chứ không trỏ ra ngoài mảng.
          activeParameter: Math.min(call.activeParam, Math.max(0, parameters.length - 1)),
        },
        dispose: () => {},
      };
    },
  };

  w.__sqlSignatureDisposables = LANG_IDS.map((lang) =>
    monacoInstance.languages.registerSignatureHelpProvider(lang, provider),
  );
}
