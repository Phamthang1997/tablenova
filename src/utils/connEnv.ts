/**
 * MÔI TRƯỜNG của một kết nối — một trường riêng trên profile, không suy ra từ màu.
 *
 * Trước đây nó được suy từ nhãn màu (đỏ = production). Cách đó sai ở chỗ căn bản: màu là thứ người
 * dùng đổi vì thẩm mỹ hoặc để phân loại việc khác, còn đây là thứ quyết định có bật chỉ-đọc và có
 * bắt gõ tên database trước câu lệnh nguy hiểm hay không. Buộc hai thứ vào nhau nghĩa là đổi màu
 * cho dễ nhìn có thể vô hiệu hoá lớp bảo vệ production mà không nói một lời — và ngược lại, muốn
 * đánh dấu production thì buộc phải chấp nhận một màu cụ thể.
 *
 * Màu giờ thuần trang trí. `legacyEnvOfColor` chỉ còn dùng đúng một lần, lúc di trú các profile cũ.
 */
export type ConnEnv = 'production' | 'staging' | 'development' | 'none';

/** Thứ tự hiển thị trong ô chọn: từ vô hại đến cần cẩn thận nhất. */
export const CONN_ENVS: readonly ConnEnv[] = ['none', 'development', 'staging', 'production'];

/**
 * Bảng màu → môi trường của bản cũ. **Chỉ dùng để di trú**, không dùng lúc chạy.
 *
 * Xanh dương và "không màu" cố ý không map: người dùng có thể đã dùng chúng để phân loại việc khác,
 * và tự ý coi chúng là production sẽ khoá những kết nối họ không hề đánh dấu.
 */
const LEGACY_BY_COLOR: Record<string, ConnEnv> = {
  '#fca5a5': 'production',
  '#fde68a': 'staging',
  '#86efac': 'development',
};

/**
 * Môi trường mà một profile cũ (chỉ có màu) từng ngụ ý.
 *
 * Gọi một lần khi nạp profile chưa có trường `env`, rồi ghi kết quả xuống. Không có bước này thì
 * mọi kết nối đang được đánh dấu production sẽ âm thầm mất dấu ngay ở lần nâng cấp — đúng loại thay
 * đổi im lặng mà lớp bảo vệ này tồn tại để chống.
 */
export function legacyEnvOfColor(color?: string | null): ConnEnv {
  if (!color) return 'none';
  return LEGACY_BY_COLOR[color.toLowerCase()] ?? 'none';
}

/** Đọc một giá trị từ localStorage/JSON về đúng kiểu, mọi thứ lạ thành `none`. */
export function normalizeEnv(value: unknown): ConnEnv {
  return CONN_ENVS.includes(value as ConnEnv) ? (value as ConnEnv) : 'none';
}

/**
 * Kết nối này có phải production không?
 *
 * Quyết định hai thứ: bật chỉ-đọc ngay khi kết nối, và bắt xác nhận hai bước trước câu lệnh nguy
 * hiểm. Cả hai đều là "chặn nhầm thì phiền, không chặn thì mất dữ liệu", nên vị từ giữ đúng một
 * nghĩa và không nới ra.
 */
export function isProduction(env?: ConnEnv | null): boolean {
  return env === 'production';
}

/** Khoá i18n của nhãn môi trường. Có cả `none` vì ô chọn phải hiện được lựa chọn đó. */
export function envLabelKey(
  env: ConnEnv,
): 'connEnv.production' | 'connEnv.staging' | 'connEnv.development' | 'connEnv.none' {
  switch (env) {
    case 'production':
      return 'connEnv.production';
    case 'staging':
      return 'connEnv.staging';
    case 'development':
      return 'connEnv.development';
    default:
      return 'connEnv.none';
  }
}
