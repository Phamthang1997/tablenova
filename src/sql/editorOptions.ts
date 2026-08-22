// Cấu hình Monaco dùng CHUNG cho mọi khung SQL (pane 1 & pane 2) — trước đây 2 pane
// khai báo riêng nên lệch font/tuỳ chọn.
import type * as monaco from 'monaco-editor';

export const SQL_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  // 12px / 18px cho khớp với phần còn lại của app (.grid-table, .structure-table đều 12px)
  fontSize: 12,
  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
  fontLigatures: true,
  lineHeight: 18,
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  glyphMargin: true, // chỗ hiển thị mũi tên "chạy câu lệnh này"
  automaticLayout: true,
  tabSize: 2,
  insertSpaces: true,
  padding: { top: 8, bottom: 8 },

  // Hiển thị
  renderLineHighlight: 'line',
  renderLineHighlightOnlyWhenFocus: true,
  renderWhitespace: 'selection',
  bracketPairColorization: { enabled: true },
  guides: { indentation: true, bracketPairs: 'active' },
  matchBrackets: 'always',
  occurrencesHighlight: 'singleFile',
  selectionHighlight: true,
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  cursorWidth: 2,
  overviewRulerBorder: false,
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },

  // Gợi ý: Enter = xuống dòng, Tab = nhận gợi ý (quy ước của các trình quản lý DB)
  acceptSuggestionOnEnter: 'off',
  tabCompletion: 'on',
  suggestOnTriggerCharacters: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  quickSuggestionsDelay: 60,
  suggestSelection: 'first',
  // PHẢI là 'inline'. 'bottom'/'top' bắt Monaco nhóm mọi item `kind: Snippet` xuống đáy
  // (hoặc lên đỉnh) và BỎ QUA sortText của chúng — trong khi thứ tự gợi ý của app hoàn
  // toàn dựa vào sortText (xem sqlLanguage.ts: '00_' sao/liệt kê cột, '0_' điều kiện JOIN,
  // '1_' cột, '2_' bảng, '4-5_' từ khoá, 'z_' mẫu câu). Đặt 'bottom' làm điều kiện JOIN
  // và mục "liệt kê N cột" bị dìm xuống dưới hàng chục cột nên coi như mất hẳn.
  snippetSuggestions: 'inline',
  wordBasedSuggestions: 'off', // chỉ gợi ý từ catalog DB + parser, không lấy từ trong văn bản
  // Panel gợi ý gọn lại (mặc định lấy theo fontSize của editor nên trông quá to)
  suggestFontSize: 12,
  suggestLineHeight: 18,
  suggest: {
    insertMode: 'replace',
    showWords: false,
    showStatusBar: false,
    localityBonus: true,
    filterGraceful: true,
    snippetsPreventQuickSuggestions: false,
    // Tắt preview: nó vẽ "ghost text" xám chèn thẳng vào dòng đang gõ (dễ bị nhìn thành
    // vệt xám bám trên câu lệnh); các trình quản lý DB cũng không có kiểu preview này.
    preview: false,
  },
  inlineSuggest: { enabled: false },
  parameterHints: { enabled: true },
  // `above: false` là bắt buộc, không phải tinh chỉnh cho đẹp. Monaco mặc định `above: true`
  // (đo trong editorOptions.js của gói — comment trong editor.api.d.ts ghi "Defaults to false"
  // là SAI), tức luôn thử vẽ hover phía trên dòng trước. Ở dòng 1 thì phía trên là ngoài khung
  // editor, và vì `fixedOverflowWidgets` cho widget tràn ra ngoài nên nó đè lên thanh tab.
  hover: { enabled: true, delay: 250, above: false },

  // Bóng đèn Quick Fix TẮT. Monaco vẽ nó ở lề glyph, mà lề đó đã bị mũi tên "chạy câu lệnh này"
  // chiếm (`glyphMargin: true` ở trên) nên hai thứ chồng lên nhau và bóng đèn tràn cả sang chữ.
  // Quick Fix vẫn dùng được bằng Alt+Enter và mục "Sửa nhanh" trong menu chuột phải — cả hai đều
  // dễ thấy hơn một icon 16px, nên ở đây không mất chức năng nào.
  lightbulb: { enabled: 'off' as monaco.editor.ShowLightbulbIconMode },

  // Khung editor chỉ cao ~220px nên hover/suggest/find bị CẮT khi render bên trong nó.
  // fixedOverflowWidgets đưa các widget đó ra container position:fixed -> tràn ra ngoài
  // khung editor được, không bị clip nữa.
  fixedOverflowWidgets: true,

  // Nhập liệu
  autoClosingBrackets: 'languageDefined',
  autoClosingQuotes: 'languageDefined',
  autoSurround: 'languageDefined',
  multiCursorModifier: 'ctrlCmd',
  find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
};
