// limit time for một statement, save **theo server** (`connKey`) giống Safe Mode.
//
// Cùng một câu hỏi with Safe Mode — "kết nối này bảo vệ mình tới đâu" — nên nó nằm cùng một popover
// on title bar and cùng một cách save, chứ not nằm in form kết nối: một giá trị người ta muốn
// đổi ngay giữa lúc currently run một câu nặng thì not nên chôn sau hai cú cuộn and một lần Save.

import { createConnPref } from './connPrefs';
import { connKey } from './connKey';
import type { DbConnectionConfig } from './dbHelper';

/** Các mức bày ra at popover, tính bằng giây. `0` = not limit. */
export const STMT_TIMEOUT_PRESETS: readonly number[] = [0, 5, 15, 30, 60, 300] as const;

// `0` is default nên nó not is save (xem `createConnPref`): số 0, số âm, and mọi thứ not must
// số đều rơi về default.
const pref = createConnPref<number>('tf_stmt_timeout', 'stmt-timeout-changed', 0, (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null,
);

export const STMT_TIMEOUT_CHANGED_EVENT = pref.EVENT;

/** Số giây already save for một server. `0` = not limit, and đó cũng is default. */
export const getStmtTimeoutForKey = (key: string): number => pref.get(key);

export const setStmtTimeoutForKey = (key: string, secs: number): void => pref.set(key, secs);

/** Giá trị already save for một config — đường mà `dbHelper.connect` dùng to nhồi ando lệnh connect. */
export function getStmtTimeoutForConfig(config: DbConnectionConfig): number {
  return getStmtTimeoutForKey(connKey(config));
}
