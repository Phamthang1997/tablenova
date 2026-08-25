// Kiểu display of thanh tiến độ dùng chung (ProgressBar.tsx / .tn-progress).
//
// Chỉ is hình thức: mọi biến thể vẽ bằng CSS thuần, select qua thuộc tính
// `data-progress-style` on <html> — cùng cơ chế with `data-theme`. to on
// <html> chứ not truyền prop xuống vì ProgressBar is build at rất nhiều dialog,
// and các dialog đó render qua portal ra ngoài <body> (xem Modal.tsx) nên not có
// context chung nào bao hết chúng.
//
// Giá trị save at `tf_progress_style` (quy ước tf_* for thiết lập toàn app, khác
// with các key theo fromng kết nối đi qua connKey.ts).

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
 * Nhãn of fromng kiểu, dạng key i18n literal.
 *
 * not ghép string `progress.${style}`: key động thì `t()` mất check kiểu
 * (xem i18next.d.ts), một kiểu mới add ando mà quên dịch will lọt tới user.
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

/** Kiểu currently save, or `classic` if chưa select / giá trị lạ (bản cũ, edit tay). */
export function getProgressStyle(): ProgressStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isProgressStyle(saved) ? saved : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Áp kiểu lên <html> and write nhớ. Gọi cả lúc khati động lẫn when user đổi. */
export function applyProgressStyle(style: ProgressStyle): void {
  document.documentElement.setAttribute('data-progress-style', style);
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Quota exceeded: style applies to current session, but won't persist to next session.
  }
}
