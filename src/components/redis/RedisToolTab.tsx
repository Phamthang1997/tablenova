// Container component for the 6 Redis tool tabs (CLI, Dashboard, SlowLog, Pub/Sub, Profiler, Analysis).
//
// Encapsulates shared error/success toast state and routes tool types to corresponding panels.



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
  /** localStorage scope — server identifier used for CLI command history. */
  storageScope: string;
  /** Connection database index for Dashboard display. Sourced from `connId`. */
  dbIndex: number;
  readOnly: boolean;
  /** Active app theme — Console shares Monaco themes with SQL query tabs. */
  theme: 'dark' | 'light';
  /** `SELECT n` in CLI: backend resolves connection for target db index. */
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
