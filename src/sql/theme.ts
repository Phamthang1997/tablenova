// Theme Monaco riêng cho TableNova.
// Không dùng trực tiếp bộ màu token của monaco-sql-languages (vs-plus) vì ở chế độ Sáng nó
// đặt comment = #B1B4C5 và dấu/toán tử = #7D98B1 (nhạt tới mức khó đọc), keyword = #3300FF
// và scope = #E221DA (chói). Ở đây định nghĩa bảng màu riêng: TÊN BẢNG/CỘT (identifier) là
// thành phần tương phản nhất — đúng thứ tự ưu tiên khi đọc SQL trong một trình quản lý DB.
import * as monaco from 'monaco-editor';

export const SQL_THEME_DARK = 'tablenova-sql-dark';
export const SQL_THEME_LIGHT = 'tablenova-sql-light';

export function sqlThemeName(theme: 'dark' | 'light' | undefined): string {
  return theme === 'light' ? SQL_THEME_LIGHT : SQL_THEME_DARK;
}

// token class của monaco-sql-languages có hậu tố '.sql' (vd 'keyword.sql')
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
  // Áp cho cả language 'sql' mặc định của Monaco (token không có hậu tố .sql)
  return rules.concat(rules.map(r => ({ ...r, token: String(r.token).replace(/\.sql$/, '') })));
}

const darkTokens = {
  keyword: '7fb3ff',    // xanh dịu — từ khoá
  scope: 'd8a0f0',      // tím nhạt — WITH/UNION/CASE...
  identifier: 'e6edf7', // tên bảng/cột: sáng nhất, dễ đọc nhất
  func: 'e5d68a',       // hàm dựng sẵn
  type: '6fd3c0',       // kiểu dữ liệu
  string: '7ee2a8',     // chuỗi
  number: 'f5b97a',     // số
  comment: '7c8899',    // comment: mờ nhưng vẫn đọc được
  punct: 'b6c2d1',      // dấu câu / toán tử
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

// Nền editor hơi trong suốt để lộ lớp kính của cửa sổ (app dùng decorations: false + vibrancy).
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
  // Panel gợi ý: chữ phải rõ ở cả dòng thường và dòng đang chọn
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

/** Đăng ký 2 theme (defineTheme ghi đè theo tên nên gọi lại khi HMR là an toàn). */
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
