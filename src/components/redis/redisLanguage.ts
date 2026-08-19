// Ngôn ngữ `redis` cho Monaco: tô màu, gợi ý lệnh, và hover.
//
// Vì sao tự viết chứ không dùng `monaco-sql-languages` như phía SQL: gói đó dựng trên ANTLR và chỉ
// có ba dialect SQL. Giao thức Redis thì không có ngữ pháp để phân tích — mỗi dòng là một lệnh, các
// từ còn lại là tham số. Một monarch tokenizer ~20 dòng nói đúng chừng đó, còn một parser sẽ giả vờ
// biết nhiều hơn thực tế.
//
// Nguồn dữ liệu là `COMMANDS` trong `commandHelp.ts` — bảng đã có sẵn cho console cũ (149 lệnh kèm
// tham số, độ phức tạp, phiên bản). Không có bảng thứ hai để lệch.

import * as monaco from 'monaco-editor';
import { COMMANDS, commandSyntax } from './commandHelp';
import { commandNameOf } from './redisScript';

export const REDIS_LANG_ID = 'redis';

/** Tên lệnh đã biết, dùng cho cả tokenizer lẫn `commandNameOf`. */
const KNOWN = COMMANDS.map((c) => c.name);

/** Từ đầu tiên của mỗi lệnh — tokenizer chỉ nhìn được một từ tại một thời điểm. */
const HEADS = Array.from(new Set(KNOWN.map((n) => n.split(' ')[0])));

/** Từ thứ hai của các lệnh hai từ (GET trong CONFIG GET, LIST trong CLIENT LIST…). */
const SUBS = Array.from(
  new Set(KNOWN.filter((n) => n.includes(' ')).map((n) => n.split(' ')[1])),
);

let registered = false;

/**
 * Đăng ký một lần cho cả app.
 *
 * Monaco là singleton toàn cục: gọi `register` lần thứ hai cho cùng một id sẽ chồng thêm provider,
 * nên mỗi tab CLI mở ra lại nhân đôi số gợi ý. Cờ ở cấp module là cách `sqlLanguage.ts` cũng dùng.
 */
export function registerRedisLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: REDIS_LANG_ID });

  monaco.languages.setLanguageConfiguration(REDIS_LANG_ID, {
    comments: { lineComment: '#' },
    brackets: [['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(REDIS_LANG_ID, {
    ignoreCase: true,
    keywords: HEADS,
    subCommands: SUBS,
    tokenizer: {
      root: [
        // Chú thích chỉ tính khi đứng ĐẦU dòng — `SET k a#b` là một giá trị hợp lệ, tô nửa sau
        // thành chú thích sẽ khiến người dùng tưởng phần đó không được gửi đi. Cùng luật với
        // `splitRedisCommands`, và đó là chủ ý: hai chỗ này phải nói cùng một điều.
        [/^\s*#.*$/, 'comment'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [
          /[a-zA-Z][\w.-]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@subCommands': 'keyword',
              '@default': 'identifier',
            },
          },
        ],
      ],
    },
  });

  monaco.languages.registerCompletionItemProvider(REDIS_LANG_ID, {
    provideCompletionItems(model, position) {
      const upto = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      // Chỉ gợi ý khi đang gõ chính tên lệnh. Có khoảng trắng rồi tức là đang ở phần tham số —
      // key và giá trị là dữ liệu của người dùng, app không biết gì để gợi ý, và một danh sách 149
      // tên lệnh bật lên giữa lúc gõ tên key chỉ tổ vướng.
      //
      // Ngoại lệ: lệnh hai từ. Sau `CONFIG ` thì từ tiếp theo vẫn là tên lệnh.
      const word = model.getWordUntilPosition(position);
      const head = upto.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
      const typingSecondWord =
        upto.trim().split(/\s+/).length <= 2 && KNOWN.some((n) => n.startsWith(head + ' '));
      if (upto.includes(' ') && !typingSecondWord) return { suggestions: [] };

      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      return {
        suggestions: COMMANDS.map((c) => ({
          label: c.name,
          kind: monaco.languages.CompletionItemKind.Function,
          // Chèn tên lệnh + một khoảng trắng khi lệnh có tham số: gợi ý xong là gõ tiếp được ngay.
          insertText: c.args ? `${c.name} ` : c.name,
          detail: c.args,
          documentation: c.description
            ? { value: [c.description, c.complexity ? `\n\n⏱ ${c.complexity}` : ''].join('') }
            : undefined,
          range,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider(REDIS_LANG_ID, {
    provideHover(model, position) {
      const line = model.getLineContent(position.lineNumber);
      const name = commandNameOf(line, KNOWN);
      const entry = commandSyntax(name);
      if (!entry) return null;
      const parts = [`**${entry.name}** ${entry.args}`.trim()];
      if (entry.description) parts.push(entry.description);
      if (entry.complexity) parts.push(`⏱ ${entry.complexity}`);
      if (entry.since) parts.push(`_since ${entry.since}_`);
      return { contents: parts.map((value) => ({ value })) };
    },
  });
}
