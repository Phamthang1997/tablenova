// Tích hợp monaco-sql-languages (parser ANTLR + gợi ý theo caret) với catalog của app.
// monaco-sql-languages tính ngữ cảnh tại con trỏ (cần table? column? keyword?...); ta cấp nội dung
// thật (bảng/cột+kiểu, alias-scope) qua completionService.
import * as monaco from 'monaco-editor';
import { setupLanguageFeatures, LanguageIdEnum, EntityContextType } from 'monaco-sql-languages';
import type { CompletionService, ICompletionItem } from 'monaco-sql-languages';
import 'monaco-sql-languages/esm/languages/mysql/mysql.contribution';
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution';
import 'monaco-sql-languages/esm/languages/generic/generic.contribution';
import * as catalog from './catalog';
import { bumpUsage, rankSort } from './usageStats';

const BUMP_CMD = 'tablenova.bumpUsage';
// Lệnh chạy sau khi chọn 1 item -> tăng tần suất dùng của tên đó
const bumpCommand = (name: string) => ({ id: BUMP_CMD, title: '', arguments: [name] });

export function langIdForDbType(dbType: string): string {
  if (dbType === 'postgres') return LanguageIdEnum.PG;
  if (dbType === 'mysql') return LanguageIdEnum.MYSQL;
  return LanguageIdEnum.GENERIC; // sqlite: dùng grammar SQL chung (sát hơn MySQL-mode)
}

// Dựng danh sách điều kiện JOIN "A.col = B.col" giữa bảng JOIN sau cùng và các bảng trước đó,
// ưu tiên foreign key; nếu không có FK thì fallback theo cột trùng tên (id/number/code).
async function buildJoinConditions(
  scopeTables: string[],
  aliasByTable: Map<string, string>
): Promise<string[]> {
  const uniq = Array.from(new Set(scopeTables));
  if (uniq.length < 2) return [];
  const last = uniq[uniq.length - 1];
  const others = uniq.slice(0, -1);
  const pfx = (t: string) => aliasByTable.get(t) || t;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (a: string, ac: string, b: string, bc: string) => {
    const s = `${pfx(a)}.${ac} = ${pfx(b)}.${bc}`;
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  };

  const lastSchema = await catalog.getSchema(last);
  for (const other of others) {
    const otherSchema = await catalog.getSchema(other);
    // FK: last -> other
    for (const fk of lastSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === other.toLowerCase()) add(last, fk.column, other, fk.refColumn);
    }
    // FK: other -> last
    for (const fk of otherSchema?.foreignKeys || []) {
      if ((fk.refTable || '').toLowerCase() === last.toLowerCase()) add(other, fk.column, last, fk.refColumn);
    }
    // Fallback: cột trùng tên trông giống khóa (id/number/code/_id)
    if (out.length === 0) {
      const lastCols = new Set((lastSchema?.columns || []).map(c => c.name.toLowerCase()));
      for (const col of otherSchema?.columns || []) {
        const n = col.name.toLowerCase();
        if (lastCols.has(n) && /(^id$|_id$|id$|number$|code$)/i.test(n)) {
          const realLast = (lastSchema?.columns || []).find(c => c.name.toLowerCase() === n)?.name || col.name;
          add(other, col.name, last, realLast);
        }
      }
    }
  }
  return out;
}

// Sinh alias ngắn cho bảng: snake_case -> initials (order_details -> od);
// camelCase -> chữ đầu + các chữ hoa (orderDetails -> od); còn lại -> chữ cái đầu. Bảo đảm không trùng.
function genAlias(table: string, taken: Set<string>): string {
  let base: string;
  const parts = table.split(/[_\s]+/).filter(Boolean);
  if (parts.length > 1) base = parts.map(p => p[0]).join('');
  else if (/[a-z][A-Z]/.test(table)) base = table[0] + (table.slice(1).match(/[A-Z]/g) || []).join('');
  else base = table.slice(0, 1);
  base = (base || 't').toLowerCase();
  let a = base;
  let n = 1;
  while (taken.has(a)) { a = base + n; n++; }
  taken.add(a);
  return a;
}

const completionService: CompletionService = async (model, position, _ctx, suggestions, entities) => {
  const items: ICompletionItem[] = [];
  if (!suggestions) return items;

  // 1) Từ khoá (đã đúng dialect do parser tính)
  for (const kw of suggestions.keywords) {
    items.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      detail: 'Từ khoá',
      insertText: kw,
      sortText: '9_' + kw, // xếp sau bảng/cột
    });
  }

  // 2) alias -> bảng, và danh sách bảng trong scope (từ entities của câu chứa caret)
  const aliasMap = new Map<string, string>(); // alias|tên (lower) -> tên bảng
  const aliasByTable = new Map<string, string>(); // tên bảng -> alias (nếu có) để hiện prefix
  const scopeTables: string[] = [];
  for (const e of entities || []) {
    if ((e as any).entityContextType === EntityContextType.TABLE) {
      const tbl = String((e as any).text || '').split('.').pop() || '';
      if (!tbl) continue;
      scopeTables.push(tbl);
      aliasMap.set(tbl.toLowerCase(), tbl);
      const alias = (e as any)['_alias']?.text;
      if (alias) {
        aliasMap.set(String(alias).toLowerCase(), tbl);
        aliasByTable.set(tbl, String(alias));
      }
    }
  }

  // 2b) B3 — Gợi ý điều kiện JOIN ON theo FOREIGN KEY (hoặc cột trùng tên) khi caret nằm sau ON
  const textBefore = model.getValueInRange({
    startLineNumber: 1, startColumn: 1,
    endLineNumber: position.lineNumber, endColumn: position.column,
  });
  const inOnClause = /\bON\s+[\w.`"]*$/i.test(textBefore);
  if (inOnClause) {
    const conds = await buildJoinConditions(scopeTables, aliasByTable);
    conds.forEach((c, i) => items.push({
      label: c,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: 'Điều kiện JOIN (FK)',
      insertText: c,
      sortText: '0_' + i, // ưu tiên cao nhất
    }));
  }

  // 3) Có tiền tố "alias." ngay trước caret không?
  const line = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const dot = line.match(/([A-Za-z_][\w$]*)\s*\.\s*[\w$]*$/);
  const prefixAlias = dot ? dot[1].toLowerCase() : null;

  // 4) Gợi ý ngữ nghĩa theo loại mà parser yêu cầu tại caret
  for (const s of suggestions.syntax) {
    const type = s.syntaxContextType;

    if (type === EntityContextType.TABLE || type === EntityContextType.VIEW) {
      // Tự đặt alias khi chèn bảng trong FROM/JOIN (không áp cho INTO/UPDATE/DROP...)
      const stripped = textBefore.replace(/[\w$."`]*$/, '').trimEnd();
      const wantAlias = /\b(from|join)$/i.test(stripped) || (/,$/.test(stripped) && /\bfrom\b/i.test(textBefore));
      const taken = new Set<string>();
      aliasByTable.forEach(a => taken.add(a.toLowerCase()));

      const tables = await catalog.getTables();
      for (const tb of tables) {
        let insertText = tb.name;
        let asSnippet = false;
        if (wantAlias) {
          const alias = genAlias(tb.name, new Set(taken)); // set riêng mỗi item để không "ăn" alias lẫn nhau
          insertText = `${tb.name} \${1:${alias}}`;
          asSnippet = true;
        }
        items.push({
          label: tb.name,
          kind: tb.type === 'view'
            ? monaco.languages.CompletionItemKind.Interface
            : monaco.languages.CompletionItemKind.Class,
          detail: tb.type === 'view' ? 'View' : 'Bảng',
          insertText,
          insertTextRules: asSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          sortText: rankSort('2', tb.name),
          command: bumpCommand(tb.name),
        });
      }
    } else if (type === EntityContextType.COLUMN) {
      // Xác định bảng cần lấy cột: theo alias trước dấu chấm > các bảng trong scope > tất cả
      let targetTables: string[];
      if (prefixAlias && aliasMap.has(prefixAlias)) {
        targetTables = [aliasMap.get(prefixAlias)!];
      } else if (scopeTables.length) {
        targetTables = Array.from(new Set(scopeTables));
      } else {
        targetTables = (await catalog.getTables()).map(t => t.name);
      }
      const multi = targetTables.length > 1;
      // Nhiều bảng và chưa gõ "alias." -> tự gắn tiền tố bảng/alias vào cột (customers.customerName)
      const qualify = multi && !prefixAlias;
      for (const tb of targetTables) {
        const schema = await catalog.getSchema(tb);
        const prefix = aliasByTable.get(tb) || tb;
        for (const col of schema?.columns || []) {
          items.push({
            label: col.name,
            kind: col.isPrimaryKey
              ? monaco.languages.CompletionItemKind.Constant
              : monaco.languages.CompletionItemKind.Field,
            detail: `${col.type}${multi ? ` · ${tb}` : ''}${col.isPrimaryKey ? ' · PK' : ''}`,
            insertText: qualify ? `${prefix}.${col.name}` : col.name,
            sortText: rankSort('1', col.name),
            command: bumpCommand(col.name),
          });
        }
      }
      // Cũng gợi ý TÊN BẢNG trong scope (để gõ tiếp "bảng." lấy cột) khi chưa có tiền tố
      if (!prefixAlias) {
        for (const tb of Array.from(new Set(scopeTables))) {
          const p = aliasByTable.get(tb) || tb;
          items.push({
            label: p,
            kind: monaco.languages.CompletionItemKind.Class,
            detail: `Bảng${aliasByTable.get(tb) ? ` (${tb})` : ''}`,
            insertText: p,
            sortText: rankSort('3', p),
            command: bumpCommand(tb),
          });
        }
      }
    }
  }

  return items;
};

let initialized = false;
export function setupSqlCompletion(): void {
  if (initialized) return;
  initialized = true;
  // Lệnh tăng tần suất dùng khi 1 gợi ý được chọn
  try {
    (monaco.editor as any).registerCommand(BUMP_CMD, (_accessor: any, name: string) => bumpUsage(name));
  } catch { /* đã đăng ký */ }
  const config = {
    completionItems: {
      enable: true,
      completionService,
      triggerCharacters: ['.', ' '],
    },
  } as any;
  setupLanguageFeatures(LanguageIdEnum.MYSQL, config);
  setupLanguageFeatures(LanguageIdEnum.PG, config);
  setupLanguageFeatures(LanguageIdEnum.GENERIC, config);
}
