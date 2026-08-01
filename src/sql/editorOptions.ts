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
  snippetSuggestions: 'bottom',
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
  hover: { enabled: true, delay: 250 },

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
