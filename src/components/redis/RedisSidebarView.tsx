// Sidebar for a Redis connection: key list + tool tab launch actions.
//
// Why a separate component rather than a mode in `Sidebar.tsx`: that file is already large and
// specialized for SQL tables/views/routines. Shared elements are container styles (.sidebar,
// footer layout, context menus) rather than DOM structure.
// (`docs/redis-ui-unification-plan.md` §3).
//
// Underlying `KeyList` remains untouched: its batch scanning and virtual windowing represent
// critical performance logic (§2.4).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ChartPie, Gauge, Hourglass, Radio, Terminal, type LucideIcon } from 'lucide-react';
import { dbHelper } from '../../utils/dbHelper';
import { ConfirmDialog } from '../ConfirmDialog';
import { BulkDeleteDialog } from './BulkDeleteDialog';
import { KeyList, type KeyListHandle } from './KeyList';
import { PromptDialog } from './PromptDialog';
import { RedisTransferDialog } from './RedisTransferDialog';
import { useRedisToast } from './useRedisToast';
import {
  REDIS_KEYS_CHANGED_EVENT,
  REDIS_TOOL_TABS,
  redisToolTabLabel,
  type RedisKeysChangedDetail,
  type RedisTabType,
} from './redisTabs';

/**
 * Icon per tool tab.
 *
 * Lives here and not in `redisTabs.ts`, which deliberately imports no React (see its header) —
 * a lucide icon is a component. The `Record` over the same union is what makes a missing entry a
 * compile error, so adding a seventh tool cannot silently render a blank button.
 *
 * `Hourglass` for Slow Log rather than `Timer`: `Timer` is already the auto-refresh control two
 * rows up in `KeyList`, and the same glyph meaning two different things in one column is worse
 * than a less obvious one.
 */
const TOOL_ICONS: Record<Exclude<RedisTabType, 'redis-key'>, LucideIcon> = {
  'redis-console': Terminal,
  'redis-dashboard': Gauge,
  'redis-slowlog': Hourglass,
  'redis-pubsub': Radio,
  'redis-profiler': Activity,
  'redis-analysis': ChartPie,
};

interface RedisSidebarViewProps {
  connId: string;
  /** `db0`... — display name of connection. */
  dbName: string;
  dbIndex: number;
  /** localStorage scope for display options — SERVER identifier, not `dbName`. */
  storageScope: string;
  readOnly: boolean;
  /** Currently active key tab, highlighted in the list. */
  activeKey: string | null;
  /** Open (or focus) key viewer tab. */
  onOpenKey: (key: string) => void;
  /** Open (or focus) a tool tab. */
  onOpenTool: (type: RedisTabType) => void;
  /** Switch db index — opens/switches to connection for that db (§2.1). */
  onSelectDb: (index: number) => void;
}

export const RedisSidebarView: React.FC<RedisSidebarViewProps> = ({
  connId,
  dbName,
  dbIndex,
  storageScope,
  readOnly,
  activeKey,
  onOpenKey,
  onOpenTool,
  onSelectDb,
}) => {
  const { t } = useTranslation();
  const { onError, onOk, blocked, node: toast } = useRedisToast(readOnly);

  const listRef = useRef<KeyListHandle>(null);
  const [creating, setCreating] = useState(false);
  const [confirmFlush, setConfirmFlush] = useState(false);
  const [bulk, setBulk] = useState<{ pattern: string; typeFilter: string } | null>(null);
  const [transfer, setTransfer] = useState<{ prefix: string; typeFilter: string } | null>(null);

  /**
   * Fired when a tab writes/deletes a key. Filtered by `connId` since multiple connections can be open
   and this list is specific to one.
   *
   * Deleting a key removes that specific row instead of re-scanning — re-scanning runs a full keyspace SCAN
   for an already known modification.
   */
  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<RedisKeysChangedDetail>).detail;
      if (!d || d.connId !== connId) return;
      if (d.renamedTo) { listRef.current?.refresh(); return; }
      if (d.removed) { listRef.current?.removeKey(d.removed); return; }
      listRef.current?.refresh();
    };
    window.addEventListener(REDIS_KEYS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(REDIS_KEYS_CHANGED_EVENT, onChanged);
  }, [connId]);

  const doCreateKey = useCallback(async (name: string) => {
    setCreating(false);
    if (!name.trim() || blocked()) return;
    const res = await dbHelper.redisSetKey({ key: name, kind: 'string', value: '' });
    if (!res.success) { onError(res.error || t('redis.errCreate')); return; }
    onOk(t('redis.createdKey', { key: name }));
    listRef.current?.refresh();
    onOpenKey(name);
  }, [blocked, onError, onOk, onOpenKey, t]);

  const doFlush = useCallback(async () => {
    setConfirmFlush(false);
    if (blocked()) return;
    const res = await dbHelper.redisFlushDb();
    if (!res.success) { onError(res.error || t('redis.errFlushDb')); return; }
    onOk(t('redis.flushDbOk'));
    listRef.current?.refresh();
  }, [blocked, onError, onOk, t]);

  /**
   * The buttons that open the tool tabs, put into `KeyList`'s footer (see `footerActions`) instead
   * of a bar of their own. Icons only: six text labels wrapped onto two rows, plus the key count
   * line, took ~103px of fixed height at the bottom of the sidebar and left this footer badly out of
   * line with the other three 34px ones. The labels still reach the user through `title`, and
   * `aria-label` keeps each button from being an anonymous icon to a screen reader.
   */
  const toolButtons = (
    <div className="redis-sidebar-actions">
      {REDIS_TOOL_TABS.map((type) => {
        const Icon = TOOL_ICONS[type];
        const label = redisToolTabLabel(type, t);
        return (
          <button
            key={type}
            className="btn btn-secondary redis-sidebar-action"
            onClick={() => onOpenTool(type)}
            title={label}
            aria-label={label}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="sidebar-navigation redis-sidebar">
      <KeyList
        ref={listRef}
        dbName={dbName}
        dbIndex={dbIndex}
        storageScope={storageScope}
        selectedKey={activeKey}
        readOnly={readOnly}
        onSelectDb={onSelectDb}
        onSelectKey={onOpenKey}
        onNewKey={() => { if (!blocked()) setCreating(true); }}
        onFlush={() => { if (!blocked()) setConfirmFlush(true); }}
        onBulkDelete={(pattern, typeFilter) => { if (!blocked()) setBulk({ pattern, typeFilter }); }}
        // Bypasses `blocked()`: this dialog allows export in read-only mode, only Import tab is blocked (enforced by backend).
        onTransfer={(prefix, typeFilter) => setTransfer({ prefix, typeFilter })}
        onError={onError}
        footerActions={toolButtons}
      />

      {toast}

      <PromptDialog
        open={creating}
        title={t('redis.newKey')}
        label={t('redis.promptNewKey')}
        placeholder="user:1"
        note={t('redis.promptNewKeyNote')}
        onSubmit={doCreateKey}
        onCancel={() => setCreating(false)}
      />
      <ConfirmDialog
        open={confirmFlush}
        title="FLUSHDB"
        message={t('redis.flushDbConfirm', { db: dbIndex })}
        note={t('redis.flushDbNote')}
        danger
        requireText="FLUSHDB"
        confirmLabel={t('redis.flushDbRun')}
        onConfirm={doFlush}
        onCancel={() => setConfirmFlush(false)}
      />
      <RedisTransferDialog
        open={transfer !== null}
        initialPrefix={transfer?.prefix ?? ''}
        initialTypeFilter={transfer?.typeFilter ?? ''}
        dbIndex={dbIndex}
        readOnly={readOnly}
        onClose={() => setTransfer(null)}
        onImported={() => listRef.current?.refresh()}
        onError={onError}
      />
      <BulkDeleteDialog
        open={bulk !== null}
        initialPattern={bulk?.pattern ?? '*'}
        initialTypeFilter={bulk?.typeFilter ?? ''}
        onClose={() => setBulk(null)}
        onDone={() => listRef.current?.refresh()}
        onError={onError}
      />
    </div>
  );
};
