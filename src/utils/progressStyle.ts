// Kiểu hiển thị của thanh tiến độ dùng chung (ProgressBar.tsx / .tn-progress).
//
// Chỉ là hình thức: mọi biến thể vẽ bằng CSS thuần, chọn qua thuộc tính
// `data-progress-style` trên <html> — cùng cơ chế với `data-theme`. Để trên
// <html> chứ không truyền prop xuống vì ProgressBar được dựng ở rất nhiều dialog,
// và các dialog đó render qua portal ra ngoài <body> (xem Modal.tsx) nên không có
// context chung nào bao hết chúng.
//
// Giá trị lưu ở `tf_progress_style` (quy ước tf_* cho thiết lập toàn app, khác
// với các khoá theo từng kết nối đi qua connKey.ts).

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
 * Nhãn của từng kiểu, dạng khoá i18n literal.
 *
 * Không ghép chuỗi `progress.${style}`: khoá động thì `t()` mất kiểm tra kiểu
 * (xem i18next.d.ts), một kiểu mới thêm vào mà quên dịch sẽ lọt tới người dùng.
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

/** Kiểu đang lưu, hoặc `classic` nếu chưa chọn / giá trị lạ (bản cũ, sửa tay). */
export function getProgressStyle(): ProgressStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isProgressStyle(saved) ? saved : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Áp kiểu lên <html> và ghi nhớ. Gọi cả lúc khởi động lẫn khi người dùng đổi. */
export function applyProgressStyle(style: ProgressStyle): void {
  document.documentElement.setAttribute('data-progress-style', style);
  try {
    localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // Hết quota: kiểu vẫn áp cho phiên này, chỉ là không nhớ được sang lần sau.
  }
}
