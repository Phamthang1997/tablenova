// Sidebar của một kết nối Redis: danh sách key + các hành động mở tab công cụ.
//
// Vì sao là một component riêng chứ không phải một chế độ bên trong `Sidebar.tsx`: file đó đã 2762
// dòng và mọi thứ trong nó nói về bảng/view/routine của SQL. Cái dùng chung ở đây là *khung* —
// cùng lớp CSS `.sidebar`, cùng kiểu footer, cùng menu chuột phải — chứ không phải cùng thân
// (`docs/redis-ui-unification-plan.md` §3).
//
// `KeyList` bên dưới giữ nguyên: phần quét theo lô, cap và windowing của nó là thứ đắt nhất trong
// cả thư mục Redis và không có lý do gì để viết lại (§2.4).

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
  /** `db0`… — tên hiển thị của kết nối. */
  dbName: string;
  dbIndex: number;
  /** localStorage scope cho tuỳ chọn hiển thị — định danh SERVER, không phải `dbName`. */
  storageScope: string;
  readOnly: boolean;
  /** Key đang mở ở tab hoạt động, để tô sáng trong danh sách. */
  activeKey: string | null;
  /** Mở (hoặc focus) tab xem key. */
  onOpenKey: (key: string) => void;
  /** Mở (hoặc focus) một tab công cụ. */
  onOpenTool: (type: RedisTabType) => void;
  /** Đổi db index — mở/chuyển sang kết nối của db đó (§2.1). */
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
   * Một tab vừa ghi/xoá key. Lọc theo `connId` vì hai kết nối Redis có thể cùng mở và danh sách
   * này chỉ nói về một cái.
   *
   * Xoá một key thì gỡ đúng dòng đó thay vì quét lại — quét lại là một vòng SCAN qua cả keyspace
   * cho một thay đổi đã biết chính xác.
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
   * Các nút mở tab công cụ, đưa vào thanh chân của `KeyList` (xem `footerActions`) thay cho một
   * thanh riêng. Chỉ còn icon: sáu nhãn chữ bọc thành hai hàng, cộng dòng đếm key, ăn ~103px chiều
   * cao cố định ở đáy sidebar và làm thanh chân này lệch hẳn so với ba thanh chân 34px còn lại.
   * Nhãn vẫn tới được người dùng qua `title`, và `aria-label` để nút không phải là một icon vô danh
   * với screen reader.
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
        // Không qua `blocked()`: dialog này xuất được ở chế độ chỉ đọc, chỉ tab Nhập bị chặn (và
        // chốt thật nằm ở `ensure_writable` trong Rust).
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
