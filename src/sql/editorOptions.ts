// Shared Monaco Editor options across SQL panes (pane 1 & pane 2) ensuring unified styling and behavior.

import type * as monaco from 'monaco-editor';

export const SQL_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  // 12px / 18px matching app layout (.grid-table, .structure-table use 12px)
  fontSize: 12,
  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
  fontLigatures: true,
  lineHeight: 18,
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  glyphMargin: true, // gutter for "run statement" arrow button
  automaticLayout: true,
  tabSize: 2,
  insertSpaces: true,
  padding: { top: 8, bottom: 8 },

  // Display
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

  // Suggest: Enter = newline, Tab = accept suggestion (standard DB IDE behavior)
  acceptSuggestionOnEnter: 'off',
  tabCompletion: 'on',
  suggestOnTriggerCharacters: true,
  quickSuggestions: { other: true, comments: false, strings: false },
  quickSuggestionsDelay: 60,
  suggestSelection: 'first',
  // MUST be 'inline'. 'bottom'/'top' forces Monaco to group `kind: Snippet` items at top/bottom
  // ignoring sortText rankings (where '00_' is wildcards, '0_' JOINs, '1_' columns, '2_' tables).
  
  
  
  snippetSuggestions: 'inline',
  wordBasedSuggestions: 'off', // suggestions sourced strictly from DB catalog and parser
  // Compact suggestion panel sizing
  suggestFontSize: 12,
  suggestLineHeight: 18,
  suggest: {
    insertMode: 'replace',
    showWords: false,
    showStatusBar: false,
    localityBonus: true,
    filterGraceful: true,
    snippetsPreventQuickSuggestions: false,
    // Disables ghost text inline preview to avoid visual confusion while editing SQL queries.
    
    preview: false,
  },
  inlineSuggest: { enabled: false },
  parameterHints: { enabled: true },
  // `above: false` is required: prevents hover popup at line 1 from clipping into the tab bar.
  
  
  
  hover: { enabled: true, delay: 250, above: false },

  // Quick Fix lightbulb disabled in gutter to prevent overlapping the run arrow.
  // Fixes remain accessible via Alt+Enter and context menu.
  
  
  lightbulb: { enabled: 'off' as monaco.editor.ShowLightbulbIconMode },

  // Container height is bounded; fixedOverflowWidgets renders popups into fixed container to prevent clipping.
  
  
  fixedOverflowWidgets: true,

  // Input handling
  autoClosingBrackets: 'languageDefined',
  autoClosingQuotes: 'languageDefined',
  autoSurround: 'languageDefined',
  multiCursorModifier: 'ctrlCmd',
  find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
};
