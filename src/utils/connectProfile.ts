// Mở một kết nối từ profile đã lưu — đường dùng CHUNG.
//
// Tồn tại vì Quick Switcher cần đúng việc mà Connection Manager đã làm: đọc profile, lấy bí mật từ
// kho HĐH, ghép vào config, gọi `dbHelper.connect`. Viết lại nó trong switcher là dựng **bản sao thứ
// hai** của đường kết nối, mà đường đó mang SSH, SSL, IAM và merge bí mật — hai bản sao sẽ lệch, và
// lệch ở đây thì biểu hiện là "profile này kết nối được ở màn kia mà không được ở đây".
//
// Chỉ phần "dựng config từ profile" nằm ở đây. Phần dựng config từ **state của form** vẫn là của
// Connection Manager và không cần dùng chung: profile đã lưu *có sẵn* config, chỉ thiếu bí mật.

import { dbHelper } from './dbHelper';
import { SECRET_FIELDS, mergeSecrets } from './secretFields';
import i18n from '../i18n';
import type { SavedProfile } from '../components/ConnectionManager';
import type { DbConnectionConfig } from './dbHelper';

const PROFILES_KEY = 'tf_connection_profiles';
const SECRET_FIELD_LIST: string[] = [...SECRET_FIELDS];

/**
 * Profile đã lưu, đọc thẳng từ localStorage.
 *
 * Không đi qua state của Connection Manager: component đó chỉ mount ở màn hình kết nối, còn switcher
 * mở từ thanh tiêu đề lúc đã vào workspace. Bản trong localStorage là bản đã bóc bí mật
 * (`persistProfiles`), nên cấu hình ở đây luôn thiếu mật khẩu — đó là ý đồ, xem `configWithSecrets`.
 */
export function loadSavedProfiles(): SavedProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Config của profile kèm bí mật đọc lại từ kho bảo mật của HĐH.
 *
 * Lỗi đọc kho **không** làm hỏng lần kết nối: trả về config trơn kèm `warning`, để người gọi vẫn thử
 * kết nối (profile không có mật khẩu vẫn hợp lệ — SQLite, hoặc server tin cậy socket) rồi hiện lỗi
 * thật của driver nếu có, thay vì chặn bằng một lỗi về keychain.
 */
export async function configWithSecrets(
  profile: SavedProfile,
): Promise<{ config: DbConnectionConfig; warning?: string }> {
  try {
    const secrets = await dbHelper.getSecrets(profile.id, SECRET_FIELD_LIST);
    return { config: mergeSecrets(profile.config, secrets) as DbConnectionConfig };
  } catch (e: any) {
    return {
      config: profile.config as DbConnectionConfig,
      warning: i18n.t('connection.errReadSecrets', { message: e?.message || String(e) }),
    };
  }
}

/**
 * Mở kết nối từ một profile đã lưu. Trả về đúng những gì `App.handleConnect` cần.
 *
 * `config` được trả ra chứ không chỉ giữ trong đây: App phải lưu nó vào `openConns` để khoá tab
 * (`scopeKey`) và để Terminal kế thừa — nhưng nó mang credential, nên không bao giờ ghi xuống đĩa từ
 * đường này (chỉ `persistProfiles` được ghi profile, và nó bóc bí mật trước).
 */
export async function connectSavedProfile(profile: SavedProfile): Promise<{
  success: boolean;
  message?: string;
  database?: string;
  schema?: string | null;
  config?: DbConnectionConfig;
}> {
  const { config, warning } = await configWithSecrets(profile);
  const res = await dbHelper.connect(config);
  if (!res.success) {
    // Lỗi keychain (nếu có) đi kèm lỗi kết nối: một mình nó không nói được gì, nhưng khi kết nối
    // thất bại thì nó thường CHÍNH LÀ nguyên nhân, và giấu đi là bắt người dùng đoán.
    return { success: false, message: warning ? `${res.message}\n\n${warning}` : res.message };
  }
  return { success: true, database: res.database, schema: res.schema, config };
}
