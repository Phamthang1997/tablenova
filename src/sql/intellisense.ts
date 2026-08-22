// Hover (xem cột/kiểu ngay trong editor) + "nhảy tới bảng" (Ctrl+Click / F12).
// Dữ liệu lấy từ catalog cache (không gọi backend mỗi lần hover).
import * as monaco from 'monaco-editor';
import * as catalog from './catalog';
import { editorConnId } from './editorScope';
import { LANG_IDS } from './sqlLanguage';
import { statementAt, resolveAliases } from './statements';
import { getDoc, formatDocMarkdown } from '../utils/docsService';
import i18n, { currentLanguage } from '../i18n';

/** Tìm bảng theo tên, không phân biệt hoa/thường. Chỉ đọc cache đã nạp. */
export async function findTable(name: string): Promise<{ name: string; type: string } | null> {
  if (!name) return null;
  const bare = name.replace(/^[`"[]|[`"\]]$/g, '');
  const tables = await catalog.getTables(editorConnId());
  return tables.find(t => t.name.toLowerCase() === bare.toLowerCase()) || null;
}

/** Yêu cầu App mở tab bảng (App.tsx lắng nghe sự kiện này). */
export function openTableTab(table: string, viewMode: 'data' | 'structure' = 'data'): void {
  window.dispatchEvent(new CustomEvent('open-table-tab', { detail: { table, viewMode } }));
}

// Markdown của hover. Chỉ phần chữ đi qua i18n; dấu markdown (`**`, `_`, `|`) và các nhãn kỹ
// thuật `PK` / `NOT NULL` ở lại trong code — chúng là cú pháp và từ khoá SQL, không phải câu văn,
// nên dịch chúng chỉ tạo thêm chỗ để lệch.
function tableMarkdown(tableName: string, type: string, schema: Awaited<ReturnType<typeof catalog.getSchema>>): string {
  const kind = type === 'view' ? i18n.t('sqlEditor.hoverKindView') : i18n.t('sqlEditor.hoverKindTable');
  const lines: string[] = [`**${tableName}** · ${kind}`];
  const cols = schema?.columns || [];
  // Giới hạn 12 dòng: bảng nhiều cột sẽ làm popup cao quá khung editor
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
 * Đăng ký hover provider cho cả 3 dialect.
 * Cờ chống-đăng-ký-trùng phải nằm trên `window`, KHÔNG dùng biến module: khi Vite HMR nạp lại
 * module thì biến module reset -> provider bị đăng ký thêm lần nữa -> hover/gợi ý bị nhân đôi.
 */
export function setupSqlHover(): void {
  const w = window as any;
  // Huỷ provider của lần nạp trước (chỉ xảy ra khi HMR trong lúc dev)
  if (Array.isArray(w.__sqlHoverDisposables)) {
    for (const d of w.__sqlHoverDisposables) {
      try { d.dispose(); } catch { /* đã huỷ */ }
    }
  }

  const provider: monaco.languages.HoverProvider = {
    async provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const name = word.word;

      // 1) Chính là tên bảng/view?
      const table = await findTable(name);
      if (table) {
        const schema = await catalog.getSchema(editorConnId(), table.name);
        return { range, contents: [{ value: tableMarkdown(table.name, table.type, schema) }] };
      }

      // 1.5) Là hàm hoặc lệnh SQL/Database? (không có tiền tố dot alias)
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

      // 2) Là cột — ưu tiên bảng suy ra từ tiền tố "alias." rồi tới các bảng trong câu lệnh
      const text = model.getValue();
      const stmt = statementAt(text, model.getOffsetAt(position));
      const aliases = stmt ? resolveAliases(stmt.text) : new Map<string, string>();

      let candidates: string[];
      // cacheOnly: khi phải quét TOÀN BỘ bảng (câu lệnh chưa có FROM) thì chỉ đọc cache,
      // không gọi backend từng bảng — nếu không, hover 1 lần có thể sinh hàng trăm lời gọi.
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
