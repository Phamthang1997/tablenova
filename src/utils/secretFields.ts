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

/**
 * Tách config thành phần lưu được (`safe`) và phần bí mật (`secrets`).
 * Bí mật rỗng bị bỏ qua để không tạo mục thừa trong kho HĐH.
 */
export function splitSecrets(config: any): { safe: any; secrets: SecretMap } {
  const safe: any = {};
  const secrets: SecretMap = {};
  if (!config || typeof config !== 'object') return { safe: config, secrets };

  for (const [k, v] of Object.entries(config)) {
    if (SECRET_SET.has(k)) {
      if (typeof v === 'string' && v !== '') secrets[k] = v;
    } else {
      safe[k] = v;
    }
  }
  return { safe, secrets };
}

/** Ghép bí mật đọc từ kho HĐH trở lại config để đem đi kết nối / xuất file. */
export function mergeSecrets(safe: any, secrets: SecretMap): any {
  return { ...(safe || {}), ...secrets };
}

/** Config có còn bí mật nằm thẳng trong đó không (profile cũ, hoặc file import). */
export function hasInlineSecrets(config: any): boolean {
  if (!config || typeof config !== 'object') return false;
  return SECRET_FIELDS.some((f) => typeof config[f] === 'string' && config[f] !== '');
}

/** Bỏ mọi khoá bí mật khỏi config (không quan tâm giá trị). */
export function stripSecrets(config: any): any {
  return splitSecrets(config).safe;
}

/** Id profile mới — dùng crypto.randomUUID() để không trùng và không đoán trước được. */
export function newProfileId(): string {
  return 'profile_' + crypto.randomUUID();
}
