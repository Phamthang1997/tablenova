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
import { buildJoinConditions } from './joinConditions';
import { collectTableRefs, statementAt } from './statements';
import { bumpUsage, rankSort } from './usageStats';
import { getDoc, formatDocMarkdown } from '../utils/docsService';

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

  // `suggestions` là null khi parser ANTLR bỏ cuộc hẳn ("no viable alternative" —
  // rất hay gặp giữa lúc gõ dở). Trước đây ta return luôn, tức KHÔNG gợi ý gì cả.
  // Giờ chạy tiếp ở chế độ suy giảm: scope lấy từ văn bản nên vẫn gợi ý được cột của
  // các bảng trong câu, tên bảng, và điều kiện JOIN.
  const parserFailed = !suggestions;
  const keywords = suggestions?.keywords ?? [];
  const syntaxHints = suggestions?.syntax ?? [];

  // 1) Từ khoá (đã đúng dialect do parser tính). Từ khoá hay dùng lên tier trước
  // (nếu không, gõ 'S' sẽ ra SAVEPOINT/SECURITY trước cả SELECT), trong cùng tier
  // thì cái nào dùng nhiều xếp trước.
  const keywordSet = new Set<string>();
  const langId = model.getLanguageId();
  for (const kw of keywords) {
    keywordSet.add(kw.toUpperCase());
    const docEntry = getDoc(kw, langId);
    items.push({
      label: kw,
      kind: docEntry ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Keyword,
      detail: docEntry ? `Hàm SQL (${docEntry.engine})` : 'Từ khoá',
      documentation: docEntry ? { value: formatDocMarkdown(docEntry) } : undefined,
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

  // 2) alias -> bảng, và danh sách bảng trong scope.
  //
  // Hai nguồn, cố ý KHÔNG chỉ dùng parser: `entities` của ANTLR chính xác khi câu lệnh
  // hợp lệ, nhưng lúc đang gõ dở thì thiếu/rỗng và sai khác theo từng dialect — đo được:
  // với `... JOIN address a on ` parser Postgres trả 2 entity (bỏ mất `address`), còn
  // với `... on c.` parser MySQL trả 0 entity. Khi đó alias mất sạch nên gợi ý cột rơi
  // về "mọi bảng" và gợi ý điều kiện JOIN không chạy. Quét văn bản (collectTableRefs)
  // bù đúng những trạng thái đó; entities vẫn được ưu tiên khi có.
  const aliasMap = new Map<string, string>(); // alias|tên (lower) -> tên bảng
  const aliasByTable = new Map<string, string>(); // tên bảng -> alias (nếu có) để hiện prefix
  const scopeTables: string[] = [];
  const addTableRef = (tbl: string, alias?: string) => {
    if (!tbl) return;
    if (!scopeTables.some(t => t.toLowerCase() === tbl.toLowerCase())) scopeTables.push(tbl);
    aliasMap.set(tbl.toLowerCase(), tbl);
    if (alias) {
      aliasMap.set(alias.toLowerCase(), tbl);
      if (!aliasByTable.has(tbl)) aliasByTable.set(tbl, alias);
    }
  };

  for (const e of entities || []) {
    if ((e as any).entityContextType === EntityContextType.TABLE) {
      const tbl = String((e as any).text || '').split('.').pop() || '';
      const alias = (e as any)['_alias']?.text;
      addTableRef(tbl, alias ? String(alias) : undefined);
    }
  }

  const fullText = model.getValue();
  const textBefore = model.getValueInRange({
    startLineNumber: 1, startColumn: 1,
    endLineNumber: position.lineNumber, endColumn: position.column,
  });

  // Bù từ văn bản của CÂU chứa caret (không phải cả tài liệu, để câu khác không lọt vào scope).
  const currentStmt = statementAt(fullText, model.getOffsetAt(position));
  for (const ref of collectTableRefs(currentStmt?.text ?? textBefore)) {
    addTableRef(ref.table, ref.alias);
  }

  // 2b) B3 — Gợi ý điều kiện JOIN ON theo FOREIGN KEY (hoặc cột trùng tên) khi caret nằm sau ON
  const inOnClause = /\bON\s+[\w.`"]*$/i.test(textBefore);
  let joinConds: string[] = [];
  if (inOnClause) {
    joinConds = await buildJoinConditions(scopeTables, aliasByTable, catalog.getSchema);
    joinConds.forEach((c, i) => items.push({
      label: c,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: 'Điều kiện JOIN (FK)',
      insertText: c,
      sortText: '0_' + i, // ưu tiên cao nhất
    }));
  }

  // Bật bằng `window.__sqlCompletionDebug = true` trong DevTools rồi gõ lại để xem vì sao
  // một gợi ý không xuất hiện. Gợi ý phụ thuộc parser + metadata từ DB nên rất khó tái hiện
  // ngoài app; đây là cách nhanh nhất để biết mắt xích nào hụt.
  if ((globalThis as any).__sqlCompletionDebug) {
    const entityTables = (entities || [])
      .filter(e => (e as any).entityContextType === EntityContextType.TABLE)
      .map(e => `${(e as any).text}${(e as any)['_alias']?.text ? ' ' + (e as any)['_alias'].text : ''}`);
    // Logged as ONE flat string, not an object: DevTools collapses nested arrays/objects
    // behind `Array(4)` / `…`, and copying the console then loses exactly the fields worth
    // reading (joinConds above all). Keep every value inline so a paste carries it.
    console.log(
      '[sql-completion]' +
        ` tail=${JSON.stringify(textBefore.slice(-40))}` +
        ` inOnClause=${inOnClause}` +
        ` parserFailed=${parserFailed}` +
        ` syntax=[${syntaxHints.map(s => s.syntaxContextType).join(' ')}]` +
        ` entityTables=[${entityTables.join(' | ')}]` +
        ` scopeTables=[${scopeTables.join(' ')}]` +
        ` aliasByTable={${[...aliasByTable].map(([tbl, a]) => `${tbl}:${a}`).join(' ')}}` +
        ` joinConds=[${joinConds.join(' | ')}]`
    );
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
  const emitTables = async () => {
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
  };

  const emitColumns = async () => {
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
  };

  if (parserFailed) {
    // Không biết caret đang cần gì -> suy ra từ văn bản. Sau "FROM|JOIN" thì cần bảng,
    // còn lại (kể cả sau "ON", sau "alias.") thì cần cột.
    const wantsTable = /\b(from|join)\s+[\w$."`]*$/i.test(textBefore);
    if (wantsTable) await emitTables();
    else await emitColumns();
  } else {
    for (const s of syntaxHints) {
      const type = s.syntaxContextType;
      if (type === EntityContextType.TABLE || type === EntityContextType.VIEW) await emitTables();
      else if (type === EntityContextType.COLUMN) await emitColumns();
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
