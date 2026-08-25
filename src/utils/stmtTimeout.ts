// The time limit for one statement, stored **per server** (`connKey`) exactly as Safe Mode is.
//
// It answers the same question Safe Mode does — "how far does this connection protect me" — so it
// lives in the same title-bar popover and is stored the same way, rather than in the connection
// form: a value someone wants to change in the middle of a heavy query should not be buried behind
// two scrolls and a Save.

import { createConnPref } from './connPrefs';
import { connKey } from './connKey';
import type { DbConnectionConfig } from './dbHelper';

/** The steps the popover offers, in seconds. `0` = no limit. */
export const STMT_TIMEOUT_PRESETS: readonly number[] = [0, 5, 15, 30, 60, 300] as const;

// `0` is the default, so it is NOT stored (see `createConnPref`): zero, negatives, and anything
// that is not a number all fall back to the default.
const pref = createConnPref<number>('tf_stmt_timeout', 'stmt-timeout-changed', 0, (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null,
);

export const STMT_TIMEOUT_CHANGED_EVENT = pref.EVENT;

/** The seconds stored for one server. `0` = no limit, which is also the default. */
export const getStmtTimeoutForKey = (key: string): number => pref.get(key);

export const setStmtTimeoutForKey = (key: string, secs: number): void => pref.set(key, secs);

/** The value stored for a config — the path `dbHelper.connect` uses to pass it into connect. */
export function getStmtTimeoutForConfig(config: DbConnectionConfig): number {
  return getStmtTimeoutForKey(connKey(config));
}
