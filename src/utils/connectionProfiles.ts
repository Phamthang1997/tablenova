// edit tại chỗ tên/màu/environment of một profile kết nối already save.
//
// Điểm write profile chính vẫn is `persistProfiles` in ConnectionManager.tsx —
// nó còn must bóc bí mật ra khỏi config and đẩy sang OS secure keystore trước
// when chạm localStorage. Hàm at đây cố tình read-only-edit-write ba trường nhãn
// (`name`, `color`, `env`) on bản already nằm in localStorage, tức bản already is bóc
// bí mật, nên not có đường nào write mật khẩu trat lại.
//
// not có tranh chấp giữa hai chỗ write: ConnectionManager chỉ tồn tại when chưa
// kết nối, còn popover chi tiết kết nối chỉ open is when already kết nối.

import type { SavedProfile } from '../components/ConnectionManager';
import type { ConnEnv } from './connEnv';

const PROFILES_KEY = 'tf_connection_profiles';

/**
 * write `patch` ando profile có id tương ứng. returns `false` when not find thấy
 * profile (kết nối build tay, chưa save thành profile) or localStorage error —
 * lúc đó phần display vẫn đổi is, chỉ is not nhớ sang lần sau.
 */
export function updateProfileDisplay(
  id: string,
  patch: { name?: string; color?: string; env?: ConnEnv },
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
        env: patch.env ?? p.env,
      };
    });
    if (!found) return false;

    localStorage.setItem(PROFILES_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
