// Những thứ mà sidebar Redis, `TabManager` và `App.tsx` đều phải đồng ý về tab Redis: định danh
// tab, danh sách tab công cụ, và tên sự kiện báo "danh sách key đã đổi".
//
// Tách ra một module không import React để ba nơi kia dùng chung mà không nơi nào phải import nơi
// còn lại — cùng lý do `utils/tabGroups.ts` tồn tại.

import type { TFunction } from 'i18next';

import type { TabInfo } from '../TabManager';

/** Bảy loại tab của một kết nối Redis. Trích từ union của `TabInfo` nên không thể lệch với nó. */
export type RedisTabType = Extract<TabInfo['type'], `redis-${string}`>;

/** Các tab công cụ (mọi loại trừ `redis-key`), theo thứ tự hiện trong footer sidebar. */
export const REDIS_TOOL_TABS: Exclude<RedisTabType, 'redis-key'>[] = [
  'redis-console',
  'redis-dashboard',
  'redis-slowlog',
  'redis-pubsub',
  'redis-profiler',
  'redis-analysis',
];

/**
 * Nhãn của một tab công cụ.
 *
 * Một `switch` trả về khoá **nguyên văn**, không phải `t(labelKey)` với khoá lấy từ bảng: khoá động
 * thì `i18next.d.ts` không kiểm được, và một khoá gõ sai sẽ lọt tới lúc chạy thay vì lúc biên dịch
 * (xem CLAUDE.md, mục i18n). Nhận `t` làm tham số vì đây là hàm cấp module, không gọi hook được —
 * cùng cách `formatRestoreEta` làm.
 */
export function redisToolTabLabel(type: Exclude<RedisTabType, 'redis-key'>, t: TFunction): string {
  switch (type) {
    case 'redis-console': return t('redis.tabConsole');
    case 'redis-dashboard': return t('redis.tabDashboard');
    case 'redis-slowlog': return t('redis.tabSlowLog');
    case 'redis-pubsub': return t('redis.tabPubSub');
    case 'redis-profiler': return t('redis.tabProfiler');
    case 'redis-analysis': return t('redis.tabAnalysis');
  }
}

/**
 * Id của tab xem một key.
 *
 * Chứa cả `connId` chứ không chỉ tên key: id tab là duy nhất trên toàn app (xem `handleCloseTab`),
 * mà cùng một tên key hoàn toàn có thể mở trên hai kết nối Redis khác nhau — hoặc trên `db0` và
 * `db3` của cùng một server, vốn là hai `connId` khác nhau (§2.1).
 */
export function redisKeyTabId(connId: string, key: string): string {
  return `rediskey_${connId}_${key}`;
}

/** Id của một tab công cụ. Một tab mỗi loại trên mỗi kết nối — bấm lại là focus, không mở thêm. */
export function redisToolTabId(connId: string, type: RedisTabType): string {
  return `redistool_${connId}_${type}`;
}

/**
 * Một tab đã ghi/xoá key và danh sách bên sidebar cần quét lại.
 *
 * `CustomEvent` trên `window` thay vì props: người phát là một tab nằm trong `ActivePanel`, người
 * nhận là sidebar — hai nhánh khác nhau của cây, và đây đã là cách `table-renamed` /
 * `database-restored` đi trong dự án này.
 *
 * `detail.connId` là bắt buộc: hai kết nối Redis có thể cùng mở, và quét lại nhầm cái kia vừa tốn
 * một vòng SCAN vừa không sửa được danh sách thật sự đã cũ.
 */
export const REDIS_KEYS_CHANGED_EVENT = 'redis-keys-changed';

export interface RedisKeysChangedDetail {
  connId: string;
  /** Key vừa biến mất — sidebar bỏ nó khỏi danh sách mà không cần quét lại toàn bộ. */
  removed?: string;
  /** Đổi tên: bỏ `removed` và thêm tên mới. */
  renamedTo?: string;
}

export function notifyRedisKeysChanged(detail: RedisKeysChangedDetail): void {
  window.dispatchEvent(new CustomEvent(REDIS_KEYS_CHANGED_EVENT, { detail }));
}
