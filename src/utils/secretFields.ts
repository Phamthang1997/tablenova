// The line between the connection config that may live in localStorage and the secrets that must live
// in the OS secret store (see src-tauri/src/secret_store.rs).
//
// A webview's localStorage is an ordinary file on disk, unencrypted — a DB password or an SSH private
// key left there is readable by any process running as the same user.

/** The keys in `profile.config` treated as secrets, never written to localStorage. */
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

// The config's two halves are produced by two INDEPENDENT functions, deliberately not by one function
// returning `{ safe, secrets }`. Merged, data-flow analysis (CodeQL) cannot separate the halves: the
// `safe` half is treated as tainted by the other, and everything that touches the profile afterwards —
// `profile.id` included — is reported as writing secrets to localStorage.

/** The part of a config that may be written to localStorage: every key except the secret ones. */
export function publicConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;

  const safe: any = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_SET.has(k)) safe[k] = v;
  }
  return safe;
}

/**
 * The secret part of a config, for pushing into the OS secret store.
 * Empty secrets are skipped, so no needless entries are created there.
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

/** Whether a config still holds secrets inline (an old profile, or an imported file). */
export function hasInlineSecrets(config: any): boolean {
  if (!config || typeof config !== 'object') return false;
  return SECRET_FIELDS.some((f) => typeof config[f] === 'string' && config[f] !== '');
}

/** A new profile id — crypto.randomUUID(), so it neither collides nor can be predicted. */
export function newProfileId(): string {
  return 'profile_' + crypto.randomUUID();
}
