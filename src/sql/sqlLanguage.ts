// Tích hợp monaco-sql-languages (parser ANTLR + gợi ý theo caret) với catalog của app.
// monaco-sql-languages tính ngữ cảnh tại con trỏ (cần table? column? keyword?...); ta cấp nội dung
// thật (bảng/cột+kiểu, alias-scope) qua completionService.
import * as monaco from 'monaco-editor';
import { setupLanguageFeatures, LanguageIdEnum, EntityContextType } from 'monaco-sql-languages';
import type { CompletionService, ICompletionItem, CompletionSnippet } from 'monaco-sql-languages';
import 'monaco-sql-languages/esm/languages/mysql/mysql.contribution';
import 'monaco-sql-languages/esm/languages/pgsql/pgsql.contribution';
import 'monaco-sql-languages/esm/languages/generic/generic.contribution';
import * as catalog from './catalog';
import { bumpUsage, rankSort } from './usageStats';

const BUMP_CMD = 'tablenova.bumpUsage';

// Từ khoá dùng thường xuyên nhất -> ưu tiên hiển thị trước các từ khoá lạ.
const COMMON_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN', 'ON',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INSERT INTO',
  'UPDATE', 'DELETE', 'SET', 'VALUES', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'AS',
  'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'WITH', 'UNION', 'IS NULL', 'IS NOT NULL', 'ASC', 'DESC', 'BETWEEN', 'EXISTS',
]);
// Lệnh chạy sau khi chọn 1 item -> tăng tần suất dùng của tên đó
const bumpCommand = (name: string) => ({ id: BUMP_CMD, title: '', arguments: [name] });

export function langIdForDbType(dbType: string): string {
  if (dbType === 'postgres') return LanguageIdEnum.PG;
  if (dbType === 'mysql') return LanguageIdEnum.MYSQL;
  return LanguageIdEnum.GENERIC; // sqlite: dùng grammar SQL chung (sát hơn MySQL-mode)
}

// Mọi language id mà editor SQL có thể dùng (để đăng ký hover/format cho đủ 3 dialect).
export const LANG_IDS: string[] = [LanguageIdEnum.MYSQL, LanguageIdEnum.PG, LanguageIdEnum.GENERIC];

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

const completionService: CompletionService = async (model, position, _ctx, suggestions, entities, snippets) => {
  const items: ICompletionItem[] = [];
  if (!suggestions) return items;

  // 1) Từ khoá (đã đúng dialect do parser tính). Từ khoá hay dùng lên tier trước
  // (nếu không, gõ 'S' sẽ ra SAVEPOINT/SECURITY trước cả SELECT), trong cùng tier
  // thì cái nào dùng nhiều xếp trước.
  const keywordSet = new Set<string>();
  for (const kw of suggestions.keywords) {
    keywordSet.add(kw.toUpperCase());
    items.push({
      label: kw,
      kind: monaco.languages.CompletionItemKind.Keyword,
      detail: 'Từ khoá',
      insertText: kw,
      sortText: rankSort(COMMON_KEYWORDS.has(kw.toUpperCase()) ? '4' : '5', kw),
      command: bumpCommand(kw),
    });
  }

  // 2) Mẫu câu (snippet) theo dialect — do monaco-sql-languages cấp, ta phải tự trả về
  // (nếu bỏ tham số `snippets` thì chúng bị mất hoàn toàn).
  // Xếp CUỐI danh sách và bỏ snippet 1 từ trùng đúng một từ khoá (vd 'SELECT', 'UPDATE')
  // để không hiện 2 dòng giống nhau và không chiếm mất lựa chọn mặc định của từ khoá.
  for (const sn of (snippets || []) as CompletionSnippet[]) {
    if (keywordSet.has(sn.prefix.toUpperCase())) continue;
    const body = Array.isArray(sn.body) ? sn.body.join('\n') : sn.body;
    items.push({
      label: sn.prefix,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: 'Mẫu câu',
      documentation: { value: ['```sql', body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d+/g, ''), '```'].join('\n') },
      insertText: sn.insertText || body,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: `${sn.prefix} ${sn.label}`,
      sortText: 'z_' + sn.prefix,
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

  // 2c) Ngay sau SELECT (chưa gõ gì) -> '*' là gợi ý ưu tiên số 1, rồi mới tới cột/bảng.
  // Nếu đã biết bảng trong scope thì thêm luôn phương án liệt kê tường minh các cột.
  if (/\bselect\s+(distinct\s+|all\s+)?$/i.test(textBefore)) {
    items.push({
      label: '*',
      kind: monaco.languages.CompletionItemKind.Field,
      detail: 'Tất cả các cột',
      insertText: '*',
      filterText: '*',
      sortText: '00_star', // trên cả điều kiện JOIN ('0_...')
      preselect: true,
    });
    for (const tbl of Array.from(new Set(scopeTables))) {
      const schema = await catalog.getSchema(tbl);
      const cols = schema?.columns || [];
      if (!cols.length) continue;
      const pfx = aliasByTable.get(tbl) || tbl;
      const multi = new Set(scopeTables).size > 1;
      const list = cols.map(c => (multi ? `${pfx}.${c.name}` : c.name)).join(', ');
      items.push({
        label: multi ? `${pfx}.* → liệt kê ${cols.length} cột` : `* → liệt kê ${cols.length} cột`,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: `Tất cả cột của ${tbl}`,
        documentation: { value: ['```sql', list, '```'].join('\n') },
        insertText: list,
        filterText: '*',
        sortText: '00_starlist_' + pfx,
      });
    }
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
        let alias: string | null = null;
        if (wantAlias) {
          alias = genAlias(tb.name, new Set(taken)); // set riêng mỗi item để không "ăn" alias lẫn nhau
          // Chèn alias như VĂN BẢN THƯỜNG, không dùng placeholder ${1:...}: placeholder giữ
          // alias ở trạng thái đang-chọn nên ký tự gõ tiếp theo (vd ';') sẽ ghi đè mất alias.
          insertText = `${tb.name} ${alias}`;
        }
        items.push({
          label: tb.name,
          kind: tb.type === 'view'
            ? monaco.languages.CompletionItemKind.Interface
            : monaco.languages.CompletionItemKind.Class,
          detail: alias ? `${tb.type === 'view' ? 'View' : 'Bảng'} · alias ${alias}` : (tb.type === 'view' ? 'View' : 'Bảng'),
          insertText,
          sortText: rankSort('2', tb.name),
          command: bumpCommand(tb.name),
        });
      }
    } else if (type === EntityContextType.COLUMN) {
      // Xác định bảng cần lấy cột: theo alias trước dấu chấm > các bảng trong scope > tất cả
      let targetTables: string[];
      // cacheOnly: nhánh "tất cả bảng" (câu lệnh chưa có FROM) chỉ đọc schema ĐÃ cache,
      // không gọi backend từng bảng — nếu không, mỗi lần gõ/xoá một ký tự (Monaco gọi lại
      // provider) có thể sinh hàng trăm lời gọi xuống Rust và làm editor giật.
      let cacheOnly = false;
      if (prefixAlias && aliasMap.has(prefixAlias)) {
        targetTables = [aliasMap.get(prefixAlias)!];
      } else if (scopeTables.length) {
        targetTables = Array.from(new Set(scopeTables));
      } else {
        targetTables = (await catalog.getTables()).map(t => t.name);
        cacheOnly = true;
      }
      const multi = targetTables.length > 1;
      // Nhiều bảng và chưa gõ "alias." -> tự gắn tiền tố bảng/alias vào cột (customers.customerName)
      const qualify = multi && !prefixAlias;
      // Chặn trần số gợi ý cột: DB lớn (vài trăm bảng) sẽ tạo hàng chục nghìn item mỗi lần
      // gõ, vừa tốn CPU dựng object vừa tốn CPU cho Monaco lọc/xếp hạng.
      const MAX_COLUMN_ITEMS = 1500;
      let columnCount = 0;
      for (const tb of targetTables) {
        if (columnCount >= MAX_COLUMN_ITEMS) break;
        const schema = cacheOnly ? catalog.getCachedSchema(tb) : await catalog.getSchema(tb);
        const prefix = aliasByTable.get(tb) || tb;
        for (const col of schema?.columns || []) {
          if (columnCount >= MAX_COLUMN_ITEMS) break;
          columnCount++;
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
