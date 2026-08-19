// Khung chung cho sáu tab công cụ Redis (CLI, Dashboard, SlowLog, Pub/Sub, Profiler, Analysis).
//
// Sáu panel bên trong không đổi — chúng vẫn nhận đúng bộ `onError`/`onOk`/`onBlocked` như khi còn
// nằm trong `RedisBrowser`. File này chỉ cấp cho mỗi tab một dòng thông báo của riêng nó và dịch
// một `type` thành panel tương ứng, để `App.tsx` không phải mang sáu nhánh JSX.

import React from 'react';
import { Analysis } from './Analysis';
// Lazy for the same reason as `SqlEditor` in `App.tsx`: the console is the Redis side's only
// edge to `monaco-editor`, and a static import here would put Monaco back into the entry chunk
// even for a Redis session that never opens the console tab.
const Console = React.lazy(() => import('./Console').then((m) => ({ default: m.Console })));
import { LazyEditorFallback } from '../LazyEditorFallback';
import { Dashboard } from './Dashboard';
import { Profiler } from './Profiler';
import { PubSub } from './PubSub';
import { SlowLog } from './SlowLog';
import { useRedisToast } from './useRedisToast';
import type { RedisTabType } from './redisTabs';

interface RedisToolTabProps {
  type: Exclude<RedisTabType, 'redis-key'>;
  /** localStorage scope — định danh server, dùng cho lịch sử lệnh của CLI. */
  storageScope: string;
  /** Db index của kết nối, chỉ để Dashboard hiển thị. Nguồn là `connId`, xem §2.1. */
  dbIndex: number;
  readOnly: boolean;
  /** Theme của app — Console dùng chung hai theme Monaco với tab truy vấn SQL. */
  theme: 'dark' | 'light';
  /** `SELECT n` gõ trong CLI: backend phân giải ra kết nối của db đó và báo lại (§2.2). */
  onSwitchDb: (index: number, connId?: string) => void;
}

export const RedisToolTab: React.FC<RedisToolTabProps> = ({
  type,
  storageScope,
  dbIndex,
  readOnly,
  theme,
  onSwitchDb,
}) => {
  const { onError, onOk, blocked, node: toast } = useRedisToast(readOnly);

  return (
    <div className="redis-tab">
      {toast}
      <div className="redis-tab-body">
        {type === 'redis-console' && (
          <React.Suspense fallback={<LazyEditorFallback />}>
            <Console storageScope={storageScope} theme={theme} onError={onError} onSelectedDb={onSwitchDb} />
          </React.Suspense>
        )}
        {type === 'redis-dashboard' && <Dashboard dbIndex={dbIndex} onError={onError} />}
        {type === 'redis-slowlog' && (
          <SlowLog readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={blocked} />
        )}
        {type === 'redis-pubsub' && (
          <PubSub readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={blocked} />
        )}
        {type === 'redis-profiler' && <Profiler onError={onError} />}
        {type === 'redis-analysis' && <Analysis onError={onError} />}
      </div>
    </div>
  );
};
