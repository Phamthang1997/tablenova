/**
 * A connection's ENVIRONMENT — a field of its own on the profile, never inferred from the colour.
 *
 * It used to be inferred from the colour label (red = production). That was wrong at the root: a
 * colour is something the user changes for looks or to categorise something else, while this decides
 * whether read-only comes on and whether a dangerous statement demands the database name typed out.
 * Tying the two together means recolouring for readability can disable the production guard without a
 * word — and conversely, marking something production forces a particular colour on it.
 *
 * The colour is now purely decorative. `legacyEnvOfColor` is used exactly once, migrating old
 * profiles.
 */
export type ConnEnv = 'production' | 'staging' | 'development' | 'none';

/** The order shown in the picker: from harmless to the one needing most care. */
export const CONN_ENVS: readonly ConnEnv[] = ['none', 'development', 'staging', 'production'];

/**
 * The old colour → environment table. **For migration only**, never at runtime.
 *
 * Blue and "no colour" are deliberately unmapped: the user may have been using them to categorise
 * something else, and treating them as production would lock connections they never marked.
 */
const LEGACY_BY_COLOR: Record<string, ConnEnv> = {
  '#fca5a5': 'production',
  '#fde68a': 'staging',
  '#86efac': 'development',
};

/**
 * The environment an old profile (colour only) used to imply.
 *
 * Called once while loading a profile without an `env` field, and the result is written back. Without
 * this step every connection currently marked production silently loses that mark on the upgrade —
 * exactly the kind of silent change this guard exists to prevent.
 */
export function legacyEnvOfColor(color?: string | null): ConnEnv {
  if (!color) return 'none';
  return LEGACY_BY_COLOR[color.toLowerCase()] ?? 'none';
}

/** Reads a value from localStorage/JSON into the right type; anything unfamiliar becomes `none`. */
export function normalizeEnv(value: unknown): ConnEnv {
  return CONN_ENVS.includes(value as ConnEnv) ? (value as ConnEnv) : 'none';
}

/**
 * Is this connection production?
 *
 * It decides two things: turning read-only on as soon as it connects, and demanding a two-step
 * confirmation before a dangerous statement. Both are "blocking wrongly is a nuisance, not blocking
 * loses data", so the predicate keeps exactly one meaning and is never loosened.
 */
export function isProduction(env?: ConnEnv | null): boolean {
  return env === 'production';
}

/** The i18n key of an environment's label. `none` is included, because the picker has to show that option. */
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
