// Custom Monaco theme for TableGrid.
// Avoids direct monaco-sql-languages token palette (vs-plus) because in Light mode it
// sets comment = #B1B4C5 and operators = #7D98B1 (hard to read), keyword = #3300FF
// and scope = #E221DA (harsh). Custom palette prioritizes TABLE/COLUMN NAMES (identifier) as
// highest-contrast elements — the natural reading priority for SQL database tools.
import * as monaco from 'monaco-editor';

export const SQL_THEME_DARK = 'tablegrid-sql-dark';
export const SQL_THEME_LIGHT = 'tablegrid-sql-light';

export function sqlThemeName(theme: 'dark' | 'light' | undefined): string {
  return theme === 'light' ? SQL_THEME_LIGHT : SQL_THEME_DARK;
}

// monaco-sql-languages token classes have '.sql' suffix (e.g. 'keyword.sql')
const t = (token: string) => `${token}.sql`;

type Rule = monaco.editor.ITokenThemeRule;

function rulesFor(c: Record<string, string>): Rule[] {
  const rules: Rule[] = [
    { token: t('keyword'), foreground: c.keyword },
    { token: t('operator.keyword'), foreground: c.keyword },
    { token: t('keyword.scope'), foreground: c.scope },
    { token: t('identifier'), foreground: c.identifier },
    { token: t('identifier.quote'), foreground: c.identifier },
    { token: t('predefined'), foreground: c.func },
    { token: t('type'), foreground: c.type },
    { token: t('string'), foreground: c.string },
    { token: t('string.double'), foreground: c.string },
    { token: t('string.escape'), foreground: c.string },
    { token: t('number'), foreground: c.number },
    { token: t('number.float'), foreground: c.number },
    { token: t('number.binary'), foreground: c.number },
    { token: t('number.octal'), foreground: c.number },
    { token: t('number.hex'), foreground: c.number },
    { token: t('binary'), foreground: c.number },
    { token: t('binary.escape'), foreground: c.number },
    { token: t('comment'), foreground: c.comment, fontStyle: 'italic' },
    { token: t('comment.quote'), foreground: c.comment, fontStyle: 'italic' },
    { token: t('delimiter'), foreground: c.punct },
    { token: t('delimiter.paren'), foreground: c.punct },
    { token: t('delimiter.curly'), foreground: c.punct },
    { token: t('delimiter.square'), foreground: c.punct },
    { token: t('operator'), foreground: c.punct },
    { token: t('operator.symbol'), foreground: c.punct },
    { token: t('variable'), foreground: c.variable },
  ];
  // Applies to default Monaco 'sql' language too (tokens without .sql suffix)
  return rules.concat(rules.map(r => ({ ...r, token: String(r.token).replace(/\.sql$/, '') })));
}

const darkTokens = {
  keyword: '7fb3ff',    // soft blue — keywords
  scope: 'd8a0f0',      // soft purple — WITH/UNION/CASE...
  identifier: 'e6edf7', // table/column names: high contrast, most readable
  func: 'e5d68a',       // built-in functions
  type: '6fd3c0',       // data types
  string: '7ee2a8',     // strings
  number: 'f5b97a',     // numbers
  comment: '7c8899',    // comment: muted but legible
  punct: 'b6c2d1',      // punctuation / operators
  variable: '7fd6ff',
};

const lightTokens = {
  keyword: '1d4ed8',
  scope: '7c3aed',
  identifier: '0f172a',
  func: '0e7490',
  type: '0369a1',
  string: '047857',
  number: 'b45309',
  comment: '64748b',
  punct: '475569',
  variable: '0f766e',
};

// Subtle editor background transparency exposing window vibrancy (decorations: false + vibrancy).
const darkColors: monaco.editor.IColors = {
  'editor.background': '#10121899',
  'editor.foreground': '#e6edf7',
  'editorGutter.background': '#00000000',
  'editorLineNumber.foreground': '#5b6675',
  'editorLineNumber.activeForeground': '#a9b6c8',
  'editor.lineHighlightBackground': '#ffffff0a',
  'editor.lineHighlightBorder': '#00000000',
  'editorCursor.foreground': '#60a5fa',
  'editor.selectionBackground': '#3b82f659',
  'editor.inactiveSelectionBackground': '#3b82f626',
  'editor.selectionHighlightBackground': '#3b82f62e',
  'editor.wordHighlightBackground': '#60a5fa26',
  'editor.wordHighlightStrongBackground': '#60a5fa3d',
  'editor.findMatchBackground': '#f59e0b66',
  'editor.findMatchHighlightBackground': '#f59e0b33',
  'editorIndentGuide.background1': '#ffffff14',
  'editorIndentGuide.activeBackground1': '#ffffff33',
  'editorBracketMatch.background': '#60a5fa2e',
  'editorBracketMatch.border': '#60a5fa',
  'editorWhitespace.foreground': '#ffffff1a',
  'editorError.foreground': '#ff453a',
  'editorWarning.foreground': '#ff9f0a',
  'editorWidget.background': '#1c202af7',
  'editorWidget.foreground': '#e6edf7',
  'editorWidget.border': '#ffffff29',
  // Suggestion panel: crisp text on both normal and active rows
  'editorSuggestWidget.background': '#181b23fc',
  'editorSuggestWidget.border': '#ffffff29',
  'editorSuggestWidget.foreground': '#dbe4f0',
  'editorSuggestWidget.selectedBackground': '#2c4270',
  'editorSuggestWidget.selectedForeground': '#ffffff',
  'editorSuggestWidget.highlightForeground': '#7fb3ff',
  'editorSuggestWidget.focusHighlightForeground': '#a9ccff',
  'editorHoverWidget.background': '#181b23fc',
  'editorHoverWidget.foreground': '#dbe4f0',
  'editorHoverWidget.border': '#ffffff29',
  'list.hoverBackground': '#ffffff12',
  'scrollbarSlider.background': '#ffffff1f',
  'scrollbarSlider.hoverBackground': '#ffffff33',
  'scrollbarSlider.activeBackground': '#ffffff47',
  'editorOverviewRuler.border': '#00000000',
  'menu.background': '#1c202a',
  'menu.foreground': '#e6edf7',
  'menu.selectionBackground': '#2c4270',
  'menu.selectionForeground': '#ffffff',
  'menu.separatorBackground': '#ffffff29',
  'menu.border': '#ffffff29',
};

const lightColors: monaco.editor.IColors = {
  'editor.background': '#ffffffa6',
  'editor.foreground': '#0f172a',
  'editorGutter.background': '#00000000',
  'editorLineNumber.foreground': '#9aa7b8',
  'editorLineNumber.activeForeground': '#334155',
  'editor.lineHighlightBackground': '#0f172a08',
  'editor.lineHighlightBorder': '#00000000',
  'editorCursor.foreground': '#2563eb',
  'editor.selectionBackground': '#2563eb33',
  'editor.inactiveSelectionBackground': '#2563eb1a',
  'editor.selectionHighlightBackground': '#2563eb1f',
  'editor.wordHighlightBackground': '#2563eb1f',
  'editor.wordHighlightStrongBackground': '#2563eb33',
  'editor.findMatchBackground': '#f59e0b7a',
  'editor.findMatchHighlightBackground': '#f59e0b40',
  'editorIndentGuide.background1': '#0f172a14',
  'editorIndentGuide.activeBackground1': '#0f172a33',
  'editorBracketMatch.background': '#2563eb1f',
  'editorBracketMatch.border': '#2563eb',
  'editorWhitespace.foreground': '#0f172a26',
  'editorError.foreground': '#dc2626',
  'editorWarning.foreground': '#d97706',
  'editorWidget.background': '#fffffff7',
  'editorWidget.foreground': '#0f172a',
  'editorWidget.border': '#0f172a26',
  'editorSuggestWidget.background': '#fffffffc',
  'editorSuggestWidget.border': '#0f172a26',
  'editorSuggestWidget.foreground': '#0f172a',
  'editorSuggestWidget.selectedBackground': '#dbe8fe',
  'editorSuggestWidget.selectedForeground': '#0b1220',
  'editorSuggestWidget.highlightForeground': '#1d4ed8',
  'editorSuggestWidget.focusHighlightForeground': '#1e40af',
  'editorHoverWidget.background': '#fffffffc',
  'editorHoverWidget.foreground': '#0f172a',
  'editorHoverWidget.border': '#0f172a26',
  'list.hoverBackground': '#0f172a0a',
  'scrollbarSlider.background': '#0f172a1a',
  'scrollbarSlider.hoverBackground': '#0f172a2e',
  'scrollbarSlider.activeBackground': '#0f172a40',
  'editorOverviewRuler.border': '#00000000',
  'menu.background': '#ffffff',
  'menu.foreground': '#0f172a',
  'menu.selectionBackground': '#2563eb14',
  'menu.selectionForeground': '#2563eb',
  'menu.separatorBackground': '#0f172a14',
  'menu.border': '#0f172a26',
};

/** Registers 2 themes (defineTheme overwrites by name, safe across HMR). */
export function defineSqlThemes(): void {
  monaco.editor.defineTheme(SQL_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: rulesFor(darkTokens),
    colors: darkColors,
  });

  monaco.editor.defineTheme(SQL_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: rulesFor(lightTokens),
    colors: lightColors,
  });
}
