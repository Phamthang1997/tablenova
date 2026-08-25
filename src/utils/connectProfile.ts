// open một kết nối from profile already save — đường dùng CHUNG.
//
// Tồn tại vì Quick Switcher cần đúng việc mà Connection Manager already ism: read profile, lấy bí mật from
// kho HĐH, ghép ando config, gọi `dbHelper.connect`. Viết lại nó in switcher is build **bản sao thứ
// hai** of đường kết nối, mà đường đó mang SSH, SSL, IAM and merge bí mật — hai bản sao will lệch, and
// lệch at đây thì biểu hiện is "profile này kết nối is at màn kia mà not is at đây".
//
// Chỉ phần "build config from profile" nằm at đây. Phần build config from **state of form** vẫn is of
// Connection Manager and not cần dùng chung: profile already save *có sẵn* config, chỉ thiếu bí mật.

import { dbHelper } from './dbHelper';
import { SECRET_FIELDS, mergeSecrets } from './secretFields';
import i18n from '../i18n';
import type { SavedProfile } from '../components/ConnectionManager';
import type { DbConnectionConfig } from './dbHelper';

const PROFILES_KEY = 'tf_connection_profiles';
const SECRET_FIELD_LIST: string[] = [...SECRET_FIELDS];

/**
 * Profile already save, read thẳng from localStorage.
 *
 * not đi qua state of Connection Manager: component đó chỉ mount at màn hình kết nối, còn switcher
 * open from title bar lúc already ando workspace. Bản in localStorage is bản already bóc bí mật
 * (`persistProfiles`), nên configuration at đây luôn thiếu mật khẩu — đó is ý đồ, xem `configWithSecrets`.
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
 * Config of profile kèm bí mật read lại from OS secure keystore.
 *
 * error read kho **not** ism hỏng lần kết nối: returns config trơn kèm `warning`, to người gọi vẫn thử
 * kết nối (profile not có mật khẩu vẫn valid — SQLite, or server tin cậy socket) rồi hiện error
 * thật of driver if có, thay vì chặn bằng một error về keychain.
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
 * open kết nối from một profile already save. returns đúng những gì `App.handleConnect` cần.
 *
 * `config` is trả ra chứ not chỉ giữ in đây: App must save nó ando `openConns` to key tab
 * (`scopeKey`) and to Terminal kế thừa — nhưng nó mang credential, nên not bao giờ write xuống đĩa from
 * đường này (chỉ `persistProfiles` is write profile, and nó bóc bí mật trước).
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
    // error keychain (if có) đi kèm error kết nối: một mình nó not nói is gì, nhưng when kết nối
    // failed thì nó thường CHÍNH is nguyên nhân, and giấu đi is bắt user đoán.
    return { success: false, message: warning ? `${res.message}\n\n${warning}` : res.message };
  }
  return { success: true, database: res.database, schema: res.schema, config };
}
