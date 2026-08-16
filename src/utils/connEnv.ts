/**
 * Ý nghĩa MÔI TRƯỜNG của nhãn màu kết nối.
 *
 * Màu đã có sẵn từ trước (`SavedProfile.color`, bảng màu ở `ConnectionInfoPopover`) nhưng chỉ là
 * trang trí. Gắn ngữ nghĩa cho nó ở đây, một chỗ, để rail và hộp xác nhận không tự diễn giải mỗi
 * nơi một kiểu — hai nơi hiểu "đỏ" khác nhau thì cảnh báo sẽ hiện ở chỗ này mà không hiện ở chỗ kia.
 *
 * Chỉ ba màu mang ý nghĩa. Xanh dương và "không màu" cố ý **không** map thành môi trường nào: người
 * dùng có thể đã dùng chúng để phân loại việc khác từ trước, và tự ý coi chúng là production sẽ chặn
 * những kết nối họ không hề đánh dấu.
 */
export type ConnEnv = 'production' | 'staging' | 'development' | 'none';

const BY_COLOR: Record<string, ConnEnv> = {
  '#fca5a5': 'production',
  '#fde68a': 'staging',
  '#86efac': 'development',
};

export function envOfColor(color?: string | null): ConnEnv {
  if (!color) return 'none';
  return BY_COLOR[color.toLowerCase()] ?? 'none';
}

/**
 * Kết nối này có phải production không?
 *
 * Quyết định hai thứ: bật chỉ-đọc ngay khi kết nối, và bắt xác nhận hai bước trước câu lệnh nguy
 * hiểm. Cả hai đều là "chặn nhầm thì phiền, không chặn thì mất dữ liệu", nên vị từ giữ đúng một
 * nghĩa và không nới ra.
 */
export function isProduction(color?: string | null): boolean {
  return envOfColor(color) === 'production';
}

/** Khoá i18n của nhãn môi trường, để hiển thị. `none` không có nhãn. */
export function envLabelKey(env: ConnEnv): 'connEnv.production' | 'connEnv.staging' | 'connEnv.development' | null {
  switch (env) {
    case 'production':
      return 'connEnv.production';
    case 'staging':
      return 'connEnv.staging';
    case 'development':
      return 'connEnv.development';
    default:
      return null;
  }
}
