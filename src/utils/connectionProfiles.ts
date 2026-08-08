// Sửa tại chỗ tên/màu của một profile kết nối đã lưu.
//
// Điểm ghi profile chính vẫn là `persistProfiles` trong ConnectionManager.tsx —
// nó còn phải bóc bí mật ra khỏi config và đẩy sang kho bảo mật của HĐH trước
// khi chạm localStorage. Hàm ở đây cố tình chỉ đọc-sửa-ghi hai trường hiển thị
// (`name`, `color`) trên bản ĐÃ nằm trong localStorage, tức bản đã bị bóc bí mật,
// nên không có đường nào ghi mật khẩu trở lại.
//
// Không có tranh chấp giữa hai chỗ ghi: ConnectionManager chỉ tồn tại khi chưa
// kết nối, còn popover chi tiết kết nối chỉ mở được khi đã kết nối.

import type { SavedProfile } from '../components/ConnectionManager';

const PROFILES_KEY = 'tf_connection_profiles';

/**
 * Ghi `patch` vào profile có id tương ứng. Trả về `false` khi không tìm thấy
 * profile (kết nối dựng tay, chưa lưu thành profile) hoặc localStorage lỗi —
 * lúc đó phần hiển thị vẫn đổi được, chỉ là không nhớ sang lần sau.
 */
export function updateProfileDisplay(
  id: string,
  patch: { name?: string; color?: string },
): boolean {
  if (!id) return false;
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return false;
    const profiles: SavedProfile[] = JSON.parse(raw);
    if (!Array.isArray(profiles)) return false;

    let found = false;
    const next = profiles.map((p) => {
      if (p.id !== id) return p;
      found = true;
      return {
        ...p,
        name: patch.name ?? p.name,
        color: patch.color ?? p.color,
      };
    });
    if (!found) return false;

    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
