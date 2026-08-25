/**
 * environment of một kết nối — một trường riêng on profile, not suy ra from màu.
 *
 * Trước đây nó is suy from nhãn màu (đỏ = production). Cách đó sai at chỗ căn bản: màu is thứ người
 * dùng đổi vì thẩm mỹ or to categorize việc khác, còn đây is thứ quyết định có bật chỉ-read and có
 * bắt gõ tên database trước statement nguy hiểm hay not. Buộc hai thứ ando nhau nghĩa is đổi màu
 * for dễ nhìn can vô hiệu hoá lớp bảo vệ production mà not nói một lời — and ngược lại, muốn
 * đánh dấu production thì buộc must chấp receive một màu cụ thể.
 *
 * Màu giờ thuần trang trí. `legacyEnvOfColor` chỉ còn dùng đúng một lần, lúc di trú các profile cũ.
 */
export type ConnEnv = 'production' | 'staging' | 'development' | 'none';

/** Thứ tự display in ô select: from vô hại đến cần chide thận nhất. */
export const CONN_ENVS: readonly ConnEnv[] = ['none', 'development', 'staging', 'production'];

/**
 * table màu → environment of bản cũ. **Chỉ dùng to di trú**, not dùng lúc run.
 *
 * Xanh dương and "not màu" cố ý not map: user can already dùng chúng to categorize việc khác,
 * and tự ý coi chúng is production will key những kết nối họ not hề đánh dấu.
 */
const LEGACY_BY_COLOR: Record<string, ConnEnv> = {
  '#fca5a5': 'production',
  '#fde68a': 'staging',
  '#86efac': 'development',
};

/**
 * environment mà một profile cũ (chỉ có màu) fromng ngụ ý.
 *
 * Gọi một lần when load profile chưa có trường `env`, rồi write kết quả xuống. not có bước này thì
 * mọi kết nối currently is đánh dấu production will âm thầm mất dấu ngay at lần nâng cấp — đúng loại thay
 * đổi im lặng mà lớp bảo vệ này tồn tại to chống.
 */
export function legacyEnvOfColor(color?: string | null): ConnEnv {
  if (!color) return 'none';
  return LEGACY_BY_COLOR[color.toLowerCase()] ?? 'none';
}

/** read một giá trị from localStorage/JSON về đúng kiểu, mọi thứ lạ thành `none`. */
export function normalizeEnv(value: unknown): ConnEnv {
  return CONN_ENVS.includes(value as ConnEnv) ? (value as ConnEnv) : 'none';
}

/**
 * Kết nối này có must production not?
 *
 * Quyết định hai thứ: bật chỉ-read ngay when kết nối, and bắt confirm hai bước trước statement nguy
 * hiểm. Cả hai đều is "chặn nhầm thì phiền, not chặn thì mất dữ liệu", nên vị from giữ đúng một
 * nghĩa and not nới ra.
 */
export function isProduction(env?: ConnEnv | null): boolean {
  return env === 'production';
}

/** key i18n of nhãn environment. Có cả `none` vì ô select must hiện is lựa select đó. */
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
