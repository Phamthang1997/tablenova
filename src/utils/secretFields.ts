// Ranh giới giữa phần cấu hình kết nối được phép nằm trong localStorage và phần bí mật
// bắt buộc phải nằm trong kho bảo mật của HĐH (xem src-tauri/src/secret_store.rs).
//
// localStorage của webview là file thường trên đĩa, không mã hoá — mật khẩu DB hay private
// key SSH để ở đó thì bất kỳ tiến trình nào chạy dưới cùng user cũng đọc được.

/** Các khoá trong `profile.config` được coi là bí mật, không bao giờ ghi xuống localStorage. */
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

// Hai nửa của config được lấy bằng hai hàm ĐỘC LẬP, cố ý không dùng chung một hàm
// trả về `{ safe, secrets }`. Gộp lại thì phân tích luồng dữ liệu (CodeQL) không tách
// được hai nửa: nửa `safe` bị coi là nhạy cảm lây từ nửa kia, và mọi thứ chạm vào
// profile sau đó — kể cả `profile.id` — bị báo là ghi bí mật ra localStorage.

/** Phần config được phép ghi xuống localStorage: mọi khoá trừ khoá bí mật. */
export function publicConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;

  const safe: any = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_SET.has(k)) safe[k] = v;
  }
  return safe;
}

/**
 * Phần bí mật của config, để đẩy sang kho bảo mật của HĐH.
 * Bí mật rỗng bị bỏ qua để không tạo mục thừa trong kho.
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

/** Merges secrets read from OS store back into config for connection / file export. */
export function mergeSecrets(safe: any, secrets: SecretMap): any {
  return { ...safe, ...secrets };
}

/** Config có còn bí mật nằm thẳng trong đó không (profile cũ, hoặc file import). */
export function hasInlineSecrets(config: any): boolean {
  if (!config || typeof config !== 'object') return false;
  return SECRET_FIELDS.some((f) => typeof config[f] === 'string' && config[f] !== '');
}

/** Id profile mới — dùng crypto.randomUUID() để không trùng và không đoán trước được. */
export function newProfileId(): string {
  return 'profile_' + crypto.randomUUID();
}
