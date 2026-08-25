// Ranh giới giữa phần configuration kết nối is phép nằm in localStorage and phần bí mật
// bắt buộc must nằm in OS secure keystore (xem src-tauri/src/secret_store.rs).
//
// localStorage of webview is file thường on đĩa, not mã hoá — mật khẩu DB hay private
// key SSH to at đó thì bất kỳ tiến trình nào run under cùng user cũng read is.

/** Các key in `profile.config` is coi is bí mật, not bao giờ write xuống localStorage. */
export const SECRET_FIELDS = [
  'password',
  'sshPassword',
  'sshPassphrase',
  'sshKeyContent',
  'awsSecretAccessKey',
  'awsSessionToken',
] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];
export type SecretMap = Record<string, string>;

const SECRET_SET: ReadonlySet<string> = new Set(SECRET_FIELDS);

// Hai nửa of config is lấy bằng hai hàm ĐỘC LẬP, cố ý not dùng chung một hàm
// returns `{ safe, secrets }`. Gộp lại thì phân tích luồng dữ liệu (CodeQL) not tách
// is hai nửa: nửa `safe` is coi is nhạy cảm lây from nửa kia, and mọi thứ chạm ando
// profile sau đó — kể cả `profile.id` — is báo is write bí mật ra localStorage.

/** Phần config is phép write xuống localStorage: mọi key trừ key bí mật. */
export function publicConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;

  const safe: any = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_SET.has(k)) safe[k] = v;
  }
  return safe;
}

/**
 * Phần bí mật of config, to đẩy sang OS secure keystore.
 * Bí mật rỗng is skip to not create mục thừa in kho.
 */
export function pickSecrets(config: any): SecretMap {
  const secrets: SecretMap = {};
  if (!config || typeof config !== 'object') return secrets;

  for (const f of SECRET_FIELDS) {
    const v = config[f];
    if (typeof v === 'string' && v !== '') secrets[f] = v;
  }
  return secrets;
}

/** Ghép bí mật read from kho HĐH trat lại config to đem đi kết nối / xuất file. */
export function mergeSecrets(safe: any, secrets: SecretMap): any {
  return { ...(safe || {}), ...secrets };
}

/** Config có còn bí mật nằm thẳng in đó not (profile cũ, or file import). */
export function hasInlineSecrets(config: any): boolean {
  if (!config || typeof config !== 'object') return false;
  return SECRET_FIELDS.some((f) => typeof config[f] === 'string' && config[f] !== '');
}

/** Id profile mới — dùng crypto.randomUUID() to not trùng and not đoán trước is. */
export function newProfileId(): string {
  return 'profile_' + crypto.randomUUID();
}
