// The visual style of the shared progress bar (ProgressBar.tsx / .tn-progress).
//
// Purely visual: every variant is drawn in plain CSS and selected through the `data-progress-style`
// attribute on <html> — the same mechanism as `data-theme`. It lives on <html> rather than being
// passed down as a prop because ProgressBar is built inside a great many dialogs, and those render
// through a portal into <body> (see Modal.tsx), so no shared context encloses them all.
//
// The value is stored in `tf_progress_style` (the tf_* convention for app-wide settings, as opposed
// to the per-connection keys that go through connKey.ts).

const STORAGE_KEY = 'tf_progress_style';

export const PROGRESS_STYLES = [
  'classic',
  'energy',
  'pulse',
  'stripes',
  'comet',
] as const;

export type ProgressStyle = (typeof PROGRESS_STYLES)[number];

const DEFAULT_STYLE: ProgressStyle = 'classic';

/**
 * Each style's label, as a literal i18n key.
 *
 * Never concatenated as `progress.${style}`: a dynamic key loses `t()`'s type checking (see
 * i18next.d.ts), so a newly added style left untranslated would reach the user.
 */
export const PROGRESS_STYLE_LABEL_KEYS = {
  classic: 'connInfo.progressClassic',
  energy: 'connInfo.progressEnergy',
  pulse: 'connInfo.progressPulse',
  stripes: 'connInfo.progressStripes',
  comet: 'connInfo.progressComet',
} as const satisfies Record<ProgressStyle, string>;

function isProgressStyle(value: string | null): value is ProgressStyle {
  return !!value && (PROGRESS_STYLES as readonly string[]).includes(value);
}

/** The stored style, or `classic` when none was chosen or the value is unfamiliar (an old build, or hand-edited). */
export function getProgressStyle(): ProgressStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isProgressStyle(saved) ? saved : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Applies the style to <html> and remembers it. Called at startup and whenever the user changes it. */
export function applyProgressStyle(style: ProgressStyle): void {
  document.documentElement.setAttribute('data-progress-style', style);
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Quota exceeded: style applies to current session, but won't persist to next session.
  }
}
