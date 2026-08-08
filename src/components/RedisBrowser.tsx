import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Key, Terminal, Activity, AlertTriangle, CheckCircle2, Radio, Timer, BarChart3,
} from 'lucide-react';
import { dbHelper, type DbConnectionConfig, type RedisValueDetail } from '../utils/dbHelper';
import { connKey } from '../utils/connKey';
import { ConfirmDialog } from './ConfirmDialog';
import { KeyList, type KeyListHandle } from './redis/KeyList';
import { ValuePanel } from './redis/ValuePanel';
import { Console } from './redis/Console';
import { Dashboard } from './redis/Dashboard';
import { SlowLog } from './redis/SlowLog';
import { PubSub } from './redis/PubSub';
import { Profiler } from './redis/Profiler';
import { Analysis } from './redis/Analysis';
import { BulkDeleteDialog } from './redis/BulkDeleteDialog';
import { PromptDialog } from './redis/PromptDialog';

interface RedisBrowserProps {
  dbName: string;
  initialDbIndex?: number;
  /** Needed for `connKey` — per-server scope for the view settings and CLI history. */
  config?: DbConnectionConfig | null;
  /** Chế độ chỉ đọc: chặn mọi lệnh ghi. Bản chốt thật nằm ở Rust (`redis_set_read_only`). */
  readOnly?: boolean;
}

type Tab = 'value' | 'console' | 'dashboard' | 'slowlog' | 'pubsub' | 'profiler' | 'analysis';

/**
 * Shell of the Redis workspace: key list on the left, one of the tool tabs on the right.
 *
 * The panels themselves live in `./redis/*` — this file only owns the selected key, the tab,
 * the toast line and the dialogs, so adding a tab does not grow a 1,000-line component (which
 * is what this file was before it was split).
 */
export const RedisBrowser: React.FC<RedisBrowserProps> = ({
  dbName,
  initialDbIndex = 0,
  config,
  readOnly = false,
}) => {
  const { t } = useTranslation();
  const [dbIndex, setDbIndex] = useState(initialDbIndex);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisValueDetail | null>(null);
  const [tab, setTab] = useState<Tab>('value');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [settingTtl, setSettingTtl] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmFlush, setConfirmFlush] = useState(false);
  const [bulk, setBulk] = useState<{ pattern: string; typeFilter: string } | null>(null);

  const listRef = useRef<KeyListHandle>(null);

  // Server identity, never `dbName` (which is only `db0`… for Redis — see utils/connKey.ts).
  const storageScope = connKey(config) || 'redis';

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 3500);
  }, []);

  const onError = useCallback((text: string) => flash('err', text), [flash]);
  const onOk = useCallback((text: string) => flash('ok', text), [flash]);

  // Mirror the app's read-only toggle into the backend, which is where writes are actually
  // refused: the CLI console sends arbitrary command text, so a UI-only gate is bypassable.
  useEffect(() => { dbHelper.redisSetReadOnly(readOnly); }, [readOnly]);

  /** One gate for every write initiated from this panel. */
  const blocked = useCallback((): boolean => {
    if (!readOnly) return false;
    flash('err', t('redis.errReadOnly'));
    return true;
  }, [readOnly, flash, t]);

  const loadKey = useCallback(async (key: string) => {
    const d = await dbHelper.redisGetKey(key);
    if (!d.success) {
      onError(d.message || t('redis.errReadKey'));
      return null;
    }
    setDetail(d);
    return d;
  }, [onError, t]);

  const selectKey = async (key: string) => {
    setSelectedKey(key);
    setTab('value');
    setDetail(null);
    await loadKey(key);
  };

  /** Re-read the open key after a write; a key that vanished is deselected, not an error. */
  const reloadDetail = useCallback(async () => {
    if (!selectedKey) return;
    const d = await dbHelper.redisGetKey(selectedKey);
    if (!d.success) {
      listRef.current?.removeKey(selectedKey);
      setSelectedKey(null);
      setDetail(null);
      return;
    }
    setDetail(d);
  }, [selectedKey]);

  const handleSelectDb = async (idx: number) => {
    const res = await dbHelper.redisSelectDb(idx);
    if (!res.success) { onError(res.error || t('redis.errSelectDb')); return; }
    setDbIndex(idx);
    setSelectedKey(null);
    setDetail(null);
  };

  const doDeleteKey = async () => {
    const key = confirmDelete;
    setConfirmDelete(null);
    if (!key || blocked()) return;
    const res = await dbHelper.redisDeleteKeys([key]);
    if (!res.success) { onError(res.error || t('redis.errDelete')); return; }
    onOk(t('redis.deletedKey', { key }));
    listRef.current?.removeKey(key);
    if (selectedKey === key) { setSelectedKey(null); setDetail(null); }
  };

  const doCreateKey = async (name: string) => {
    setCreating(false);
    if (!name.trim() || blocked()) return;
    const res = await dbHelper.redisSetKey({ key: name, kind: 'string', value: '' });
    if (!res.success) { onError(res.error || t('redis.errCreate')); return; }
    onOk(t('redis.createdKey', { key: name }));
    listRef.current?.refresh();
    selectKey(name);
  };

  const doRename = async (next: string) => {
    setRenaming(false);
    if (!selectedKey || !next.trim() || next === selectedKey || blocked()) return;
    const res = await dbHelper.redisRenameKey(selectedKey, next);
    if (!res.success) { onError(res.error || t('redis.errRename')); return; }
    onOk(t('redis.renamed'));
    listRef.current?.refresh();
    setSelectedKey(next);
    loadKey(next);
  };

  const doSetTtl = async (raw: string) => {
    setSettingTtl(false);
    if (!selectedKey || blocked()) return;
    const ttl = parseInt(raw, 10);
    if (Number.isNaN(ttl)) { onError(t('redis.errTtlNotNumber')); return; }
    const res = await dbHelper.redisSetTtl(selectedKey, ttl);
    if (!res.success) { onError(res.error || t('redis.errTtl')); return; }
    onOk(t('redis.ttlSet'));
    reloadDetail();
  };

  const doFlush = async () => {
    setConfirmFlush(false);
    if (blocked()) return;
    const res = await dbHelper.redisFlushDb();
    if (!res.success) { onError(res.error || t('redis.errFlushDb')); return; }
    onOk(t('redis.flushDbOk'));
    listRef.current?.refresh();
    setSelectedKey(null);
    setDetail(null);
  };

  const TABS: [Tab, string, typeof Key][] = [
    ['value', t('redis.tabValue'), Key],
    ['console', t('redis.tabConsole'), Terminal],
    ['dashboard', t('redis.tabDashboard'), Activity],
    ['slowlog', t('redis.tabSlowLog'), Timer],
    ['pubsub', t('redis.tabPubSub'), Radio],
    ['profiler', t('redis.tabProfiler'), Activity],
    ['analysis', t('redis.tabAnalysis'), BarChart3],
  ];

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: '100%' }}>
      <KeyList
        ref={listRef}
        dbName={dbName}
        dbIndex={dbIndex}
        storageScope={storageScope}
        selectedKey={selectedKey}
        readOnly={readOnly}
        onSelectDb={handleSelectDb}
        onSelectKey={selectKey}
        onNewKey={() => { if (!blocked()) setCreating(true); }}
        onFlush={() => { if (!blocked()) setConfirmFlush(true); }}
        onBulkDelete={(pattern, typeFilter) => { if (!blocked()) setBulk({ pattern, typeFilter }); }}
        onError={onError}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-tab-bar)', overflowX: 'auto' }}>
          {TABS.map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', fontSize: '11px',
                cursor: 'pointer', background: 'transparent', border: 'none', whiteSpace: 'nowrap',
                borderBottom: tab === id ? '2px solid var(--win-accent)' : '2px solid transparent',
                color: tab === id ? 'var(--win-text-primary)' : 'var(--win-text-secondary)',
                fontWeight: tab === id ? 600 : 400,
              }}
            >
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>

        {msg && (
          <div style={{ padding: '6px 12px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px', background: msg.kind === 'ok' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: msg.kind === 'ok' ? '#10b981' : 'var(--st-danger)' }}>
            {msg.kind === 'ok' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {msg.text}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
          {tab === 'value' && (
            !detail ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px' }}>
                {t('redis.pickKeyHint')}
              </div>
            ) : (
              <ValuePanel
                detail={detail}
                storageScope={storageScope}
                readOnly={readOnly}
                onRename={() => setRenaming(true)}
                onSetTtl={() => setSettingTtl(true)}
                onDelete={() => setConfirmDelete(detail.key)}
                onError={onError}
                onOk={onOk}
                onBlocked={blocked}
                onReload={reloadDetail}
              />
            )
          )}
          {tab === 'console' && (
            <Console
              storageScope={storageScope}
              onError={onError}
              // `SELECT n` typed in the console is routed through the dropdown's path in Rust,
              // so the UI must follow rather than keep showing the old index.
              onSelectedDb={(idx) => { setDbIndex(idx); setSelectedKey(null); setDetail(null); }}
            />
          )}
          {tab === 'dashboard' && <Dashboard dbIndex={dbIndex} onError={onError} />}
          {tab === 'slowlog' && <SlowLog readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={blocked} />}
          {tab === 'pubsub' && <PubSub readOnly={readOnly} onError={onError} onOk={onOk} onBlocked={blocked} />}
          {tab === 'profiler' && <Profiler onError={onError} />}
          {tab === 'analysis' && <Analysis onError={onError} />}
        </div>
      </div>

      <PromptDialog
        open={creating}
        title={t('redis.newKey')}
        label={t('redis.promptNewKey')}
        placeholder="user:1"
        note={t('redis.promptNewKeyNote')}
        onSubmit={doCreateKey}
        onCancel={() => setCreating(false)}
      />
      <PromptDialog
        open={renaming}
        title={t('redis.rename')}
        label={t('redis.promptRename')}
        defaultValue={selectedKey ?? ''}
        onSubmit={doRename}
        onCancel={() => setRenaming(false)}
      />
      <PromptDialog
        open={settingTtl}
        title={t('redis.ttlTitle')}
        label={t('redis.promptTtl')}
        defaultValue={String(detail?.ttl ?? -1)}
        note={t('redis.promptTtlNote')}
        onSubmit={doSetTtl}
        onCancel={() => setSettingTtl(false)}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('redis.delete')}
        message={t('redis.confirmDeleteKey', { key: confirmDelete ?? '' })}
        danger
        confirmLabel={t('redis.delete')}
        onConfirm={doDeleteKey}
        onCancel={() => setConfirmDelete(null)}
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
