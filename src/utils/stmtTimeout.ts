// Giới hạn thời gian cho một câu lệnh, lưu **theo server** (`connKey`) giống Safe Mode.
//
// Cùng một câu hỏi với Safe Mode — "kết nối này bảo vệ mình tới đâu" — nên nó nằm cùng một popover
// trên title bar và cùng một cách lưu, chứ không nằm trong form kết nối: một giá trị người ta muốn
// đổi ngay giữa lúc đang chạy một câu nặng thì không nên chôn sau hai cú cuộn và một lần Save.

import { createConnPref } from './connPrefs';
import { connKey } from './connKey';
import type { DbConnectionConfig } from './dbHelper';

/** Các mức bày ra ở popover, tính bằng giây. `0` = không giới hạn. */
export const STMT_TIMEOUT_PRESETS: readonly number[] = [0, 5, 15, 30, 60, 300] as const;

// `0` là mặc định nên nó KHÔNG được lưu (xem `createConnPref`): số 0, số âm, và mọi thứ không phải
// số đều rơi về mặc định.
const pref = createConnPref<number>('tf_stmt_timeout', 'stmt-timeout-changed', 0, (raw) =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null,
);

export const STMT_TIMEOUT_CHANGED_EVENT = pref.EVENT;

/** Số giây đã lưu cho một server. `0` = không giới hạn, và đó cũng là mặc định. */
export const getStmtTimeoutForKey = (key: string): number => pref.get(key);

export const setStmtTimeoutForKey = (key: string, secs: number): void => pref.set(key, secs);

/** Giá trị đã lưu cho một config — đường mà `dbHelper.connect` dùng để nhồi vào lệnh connect. */
export function getStmtTimeoutForConfig(config: DbConnectionConfig): number {
  return getStmtTimeoutForKey(connKey(config));
}
