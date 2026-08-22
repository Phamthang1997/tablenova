// "Xem định nghĩa" (Alt+F12): mở DDL của bảng dưới con trỏ ngay trong một khung nhỏ chèn vào
// editor, không phải rời tab đang gõ.
//
// Khác với hành vi sẵn có: Ctrl+Click / F12 **mở hẳn một tab bảng** (`intellisense.ts` +
// `open-table-tab`). Hai thứ trả lời hai câu hỏi khác nhau — "cột này kiểu gì, khoá ở đâu" thì
// chỉ cần liếc, còn "cho tôi xem dữ liệu" thì mới đáng đổi tab. Nên phím tắt tách riêng và
// hành vi cũ giữ nguyên (dòng chữ trong hover vẫn đang hứa Ctrl+Click mở bảng).
//
// Monaco chỉ hiểu "định nghĩa" là một vị trí trong một model. Bảng thì không có tệp nguồn, nên
// ta dựng một model ảo với uri riêng chứa DDL. Model được dùng lại theo (kết nối, bảng) và có
// cập nhật nội dung mỗi lần mở, để sau một lần ALTER thì khung xem không còn là bản cũ.
import type * as monaco from 'monaco-editor';
import * as catalog from './catalog';
import { editorConnId } from './editorScope';
import { findTable } from './intellisense';
import { LANG_IDS } from './sqlLanguage';
import { dbHelper } from '../utils/dbHelper';

/**
 * DDL dựng từ catalog đã cache.
 *
 * Chỉ dùng khi backend không trả được DDL thật (mất kết nối, hoặc dialect không có lệnh tương
 * ứng). Thà hiện một bản gần đúng — vốn đúng bằng những gì hover đang hiện — còn hơn để Alt+F12
 * im lặng không ra gì, vì im lặng không phân biệt được với "tính năng hỏng".
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
 * Đăng ký definition provider cho cả 3 dialect.
 *
 * Cờ chống-đăng-ký-trùng nằm trên `window`, cùng lý do như các provider khác (Vite HMR).
 */
export function registerSqlPeekDefinition(monacoInstance: typeof monaco): void {
  const w = window as any;
  if (Array.isArray(w.__sqlDefinitionDisposables)) {
    for (const d of w.__sqlDefinitionDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
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
      } catch { /* rơi xuống bản dựng từ catalog */ }
      if (!text) text = ddlFromCatalog(table.name, catalog.getCachedSchema(connId, table.name));

      // Uri mang cả connId: hai kết nối cùng có bảng `users` là hai định nghĩa khác nhau, gộp
      // chung một model thì khung xem sẽ hiện DDL của kết nối kia.
      const uri = monacoInstance.Uri.parse(
        `tablenova://table/${encodeURIComponent(connId)}/${encodeURIComponent(table.name)}.sql`,
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
