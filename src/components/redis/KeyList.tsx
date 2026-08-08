import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, RefreshCw, Plus, Trash2, Key, Clock, Database, Square,
  ChevronRight, ChevronDown, FolderTree, List as ListIcon, Timer,
} from 'lucide-react';
import { dbHelper, type RedisKeyItem } from '../../utils/dbHelper';
import { buildKeyTree, flattenTree, allFolderPaths, windowSlice, type TreeRow } from '../../utils/redisKeyTree';
import { KEY_CAP, ROW_HEIGHT, SCAN_COUNT, TYPE_COLORS, ttlText } from './shared';

export interface KeyListHandle {
  /** Restart the scan (after a rename/import/flush). */
  refresh: () => void;
  /** Drop one key from the list without a full rescan. */
  removeKey: (key: string) => void;
}

interface KeyListProps {
  dbName: string;
  dbIndex: number;
  /** localStorage scope for the view settings — server identity, never `dbName`. */
  storageScope: string;
  selectedKey: string | null;
  readOnly: boolean;
  onSelectDb: (index: number) => void;
  onSelectKey: (key: string) => void;
  onNewKey: () => void;
  onFlush: () => void;
  onBulkDelete: (pattern: string, typeFilter: string) => void;
  onError: (msg: string) => void;
}

const AUTO_REFRESH_OPTIONS = [0, 5, 10, 30, 60];

/**
 * Left pane of the Redis browser: scan, filter, group by namespace, pick a key.
 *
 * Two things here are load-bearing and easy to undo by accident:
 *  1. The scan stops at `KEY_CAP` and *says so* — it used to run to the end of the keyspace
 *     and push every key into React state.
 *  2. Rows are windowed (`windowSlice`), so the number of mounted DOM rows is bounded by the
 *     viewport, not by the number of keys.
 */
export const KeyList = React.forwardRef<KeyListHandle, KeyListProps>(function KeyList({
  dbName,
  dbIndex,
  storageScope,
  selectedKey,
  readOnly,
  onSelectDb,
  onSelectKey,
  onNewKey,
  onFlush,
  onBulkDelete,
  onError,
}, ref) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState('*');
  const [typeFilter, setTypeFilter] = useState('');
  const [keys, setKeys] = useState<RedisKeyItem[]>([]);
  const [streaming, setStreaming] = useState(false);
  /** Set when the scan stopped early because the cap was reached. */
  const [capped, setCapped] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(0);

  // View settings are per server (see utils/connKey.ts) — two servers must not share them.
  const treeKey = `tf_redis_tree_${storageScope}`;
  const delimKey = `tf_redis_delim_${storageScope}`;
  const [treeMode, setTreeMode] = useState(() => localStorage.getItem(treeKey) !== '0');
  const [delimiter, setDelimiter] = useState(() => localStorage.getItem(delimKey) ?? ':');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scanIdRef = useRef('');
  /** Cursor to resume from, carried on every batch by `redis_scan_stream`. */
  const cursorRef = useRef(0);
  const capRef = useRef(KEY_CAP);
  /** Keys accepted so far — read synchronously while a batch arrives, unlike state. */
  const countRef = useRef(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(320);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => { localStorage.setItem(treeKey, treeMode ? '1' : '0'); }, [treeMode, treeKey]);
  useEffect(() => { localStorage.setItem(delimKey, delimiter); }, [delimiter, delimKey]);

  // ---- Scan ----
  const runScan = useCallback((pat: string, type: string, startCursor: number, append: boolean) => {
    if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current);
    const id = `rscan_${crypto.randomUUID()}`;
    scanIdRef.current = id;
    if (!append) {
      setKeys([]);
      countRef.current = 0;
      capRef.current = KEY_CAP;
    }
    // `expanded` is deliberately NOT cleared here: a refresh (manual or from auto-refresh)
    // would otherwise collapse the tree the user just opened, every few seconds. Paths that no
    // longer exist simply match no folder, so keeping them costs nothing.
    setCapped(false);
    setStreaming(true);
    dbHelper.redisScanStream(pat || '*', SCAN_COUNT, id, (msg: any) => {
      if (scanIdRef.current !== id) return; // batch của scan cũ -> bỏ
      if (msg.type === 'keys') {
        if (typeof msg.cursor === 'number') cursorRef.current = msg.cursor;
        // Type filtering is client-side: `SCAN TYPE` is Redis 6.0+ and KeyDB/Dragonfly
        // answer it with a syntax error (see redis_db.rs).
        const batch: RedisKeyItem[] = type
          ? (msg.keys || []).filter((k: RedisKeyItem) => k.type === type)
          : (msg.keys || []);
        // The cap is enforced here, not inside the `setKeys` updater: an updater must stay
        // pure (React may call it twice), and cancelling the scan is a side effect.
        if (countRef.current >= capRef.current) return;
        const room = capRef.current - countRef.current;
        const slice = batch.length > room ? batch.slice(0, room) : batch;
        countRef.current += slice.length;
        if (slice.length) setKeys((prev) => prev.concat(slice));
        if (countRef.current >= capRef.current) {
          // Stop rather than keep filling memory; the banner explains why and offers "load more".
          dbHelper.cancelQuery(id);
          setStreaming(false);
          setCapped(true);
        }
      } else if (msg.type === 'done') {
        setStreaming(false);
      } else if (msg.type === 'error') {
        setStreaming(false);
        onError(msg.message || t('redis.errScan'));
      }
    }, startCursor).catch((e) => {
      setStreaming(false);
      onError(String(e));
    });
  }, [onError, t]);

  const refresh = useCallback(() => {
    cursorRef.current = 0;
    runScan(pattern, typeFilter, 0, false);
  }, [pattern, typeFilter, runScan]);

  const loadMore = () => {
    capRef.current += KEY_CAP;
    runScan(pattern, typeFilter, cursorRef.current, true);
  };

  const stopScan = () => {
    if (scanIdRef.current) dbHelper.cancelQuery(scanIdRef.current);
    setStreaming(false);
  };

  useImperativeHandle(ref, () => ({
    refresh,
    removeKey: (key: string) => setKeys((prev) => {
      const next = prev.filter((k) => k.key !== key);
      countRef.current -= prev.length - next.length;
      return next;
    }),
  }), [refresh]);

  // Tải lần đầu + khi đổi db index. `refresh` đổi identity theo pattern/typeFilter nên
  // không đưa vào deps — nếu không, mỗi ký tự gõ vào ô pattern sẽ tự quét lại.
  // Đổi db là sang một keyspace khác hẳn, nên đây là chỗ duy nhất thu gọn lại cây.
  useEffect(() => {
    setExpanded(new Set());
    runScan(pattern, typeFilter, 0, false);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [dbIndex]);

  // Auto-refresh: only while idle, so a periodic tick can never interrupt a running scan.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => { if (!streaming) refresh(); }, autoRefresh * 1000);
    return () => window.clearInterval(id);
  }, [autoRefresh, streaming, refresh]);

  const onChangeTypeFilter = (type: string) => {
    setTypeFilter(type);
    cursorRef.current = 0;
    runScan(pattern, type, 0, false);
  };

  // ---- Rows ----
  const tree = useMemo(
    () => (treeMode ? buildKeyTree(keys, delimiter) : null),
    [treeMode, keys, delimiter],
  );
  const rows: TreeRow[] = useMemo(() => {
    if (tree) return flattenTree(tree, expanded);
    // Flat mode keeps scan order so the list visibly fills as batches arrive.
    return keys.map((item) => ({ kind: 'key' as const, item, label: item.key, depth: 0 }));
  }, [tree, expanded, keys]);

  const win = windowSlice(scrollTop, viewportH, ROW_HEIGHT, rows.length);
  const visible = rows.slice(win.start, win.end);

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(tree ? allFolderPaths(tree) : []));
  const collapseAll = () => setExpanded(new Set());

  return (
    <div style={{ width: '340px', borderRight: '1px solid var(--win-border)', display: 'flex', flexDirection: 'column', background: 'var(--win-bg-sidebar)' }}>
      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid var(--win-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Database size={14} style={{ color: 'var(--win-accent)' }} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', flex: 1 }}>{dbName}</span>
          {/* FLUSHDB đứng cạnh bộ chọn database vì nó tác động lên đúng db đang chọn —
              đặt ở đây thì phạm vi của lệnh nằm ngay bên cạnh thứ quyết định phạm vi đó,
              và nó không nằm cạnh Refresh/New key là hai nút bấm liên tục. */}
          <button
            className="btn btn-secondary"
            onClick={onFlush}
            disabled={readOnly}
            title={t('redis.flushDbTitle')}
            style={{ width: '26px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}
          >
            <Trash2 size={12} />
          </button>
          <select
            value={dbIndex}
            onChange={(e) => onSelectDb(parseInt(e.target.value))}
            title={t('redis.dbIndexTitle')}
            style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px', padding: '2px 4px' }}
          >
            {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>db{i}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', borderRadius: '4px', padding: '0 6px' }}>
            <Search size={12} style={{ color: 'var(--win-text-disabled)' }} />
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') refresh(); }}
              placeholder={t('redis.patternPlaceholder')}
              style={{ flex: 1, background: 'transparent', border: 'none', color: 'var(--win-text-primary)', fontSize: '11px', outline: 'none', padding: '5px 0' }}
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => onChangeTypeFilter(e.target.value)}
            title={t('redis.filterByTypeTitle')}
            style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px' }}
          >
            <option value="">{t('redis.allTypes')}</option>
            <option value="string">string</option>
            <option value="hash">hash</option>
            <option value="list">list</option>
            <option value="set">set</option>
            <option value="zset">zset</option>
            <option value="stream">stream</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: '4px' }}>
          {streaming ? (
            <button className="btn btn-secondary" onClick={stopScan} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', color: 'var(--st-danger)' }}>
              <Square size={10} /> {t('redis.stopScan')}
            </button>
          ) : (
            <button className="btn btn-secondary" onClick={refresh} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              <RefreshCw size={11} /> {t('redis.refresh')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={onNewKey} disabled={readOnly} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
            <Plus size={11} /> {t('redis.newKey')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => onBulkDelete(pattern, typeFilter)}
            disabled={readOnly}
            title={t('redis.bulkDeleteTitle')}
            style={{ width: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--st-danger)' }}
          >
            <Trash2 size={11} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            className="btn btn-secondary"
            onClick={() => setTreeMode(!treeMode)}
            title={treeMode ? t('redis.viewFlatTitle') : t('redis.viewTreeTitle')}
            style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            {treeMode ? <FolderTree size={11} /> : <ListIcon size={11} />}
            {treeMode ? t('redis.viewTree') : t('redis.viewFlat')}
          </button>
          {treeMode && (
            <>
              <input
                type="text"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value)}
                title={t('redis.delimiterTitle')}
                style={{ width: '34px', textAlign: 'center', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '11px', fontFamily: 'var(--win-font-mono)', padding: '3px 0' }}
              />
              <button className="btn btn-secondary" onClick={expandAll} title={t('redis.expandAll')} style={{ padding: '0 6px' }}><ChevronDown size={11} /></button>
              <button className="btn btn-secondary" onClick={collapseAll} title={t('redis.collapseAll')} style={{ padding: '0 6px' }}><ChevronRight size={11} /></button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Timer size={11} style={{ color: 'var(--win-text-disabled)' }} />
          <select
            value={autoRefresh}
            onChange={(e) => setAutoRefresh(parseInt(e.target.value))}
            title={t('redis.autoRefreshTitle')}
            style={{ background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', color: 'var(--win-text-primary)', borderRadius: '4px', fontSize: '10px' }}
          >
            {AUTO_REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 0 ? t('redis.autoRefreshOff') : `${s}s`}</option>
            ))}
          </select>
        </div>
      </div>

      {capped && (
        // Never truncate silently: say what happened and offer to continue.
        <div style={{ padding: '6px 10px', fontSize: '10px', background: 'rgba(245,158,11,0.12)', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span>{t('redis.capReached', { n: keys.length.toLocaleString() })}</span>
          <button className="btn btn-secondary" onClick={loadMore} style={{ padding: '0 8px', height: '20px' }}>
            {t('redis.loadMore')}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        style={{ flex: 1, overflowY: 'auto' }}
      >
        {rows.length === 0 && !streaming && (
          <div style={{ padding: '20px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('redis.noKeyMatch')}</div>
        )}
        {/* Spacers keep the scrollbar proportional to the full list while only the window renders. */}
        <div style={{ height: win.padTop }} />
        {visible.map((row) => (
          row.kind === 'folder' ? (
            <div
              key={`f:${row.path}`}
              onClick={() => toggleFolder(row.path)}
              className="sidebar-item"
              style={{ display: 'flex', alignItems: 'center', gap: '4px', height: ROW_HEIGHT, padding: `0 10px 0 ${10 + row.depth * 12}px`, cursor: 'pointer', fontSize: '11px', boxSizing: 'border-box' }}
            >
              {row.expanded ? <ChevronDown size={11} style={{ flexShrink: 0 }} /> : <ChevronRight size={11} style={{ flexShrink: 0 }} />}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--win-text-primary)', fontWeight: 600 }}>
                {row.label || t('redis.emptySegment')}
              </span>
              <span style={{ fontSize: '9px', color: 'var(--win-text-disabled)' }}>{row.count.toLocaleString()}</span>
            </div>
          ) : (
            <div
              key={`k:${row.item.key}`}
              onClick={() => onSelectKey(row.item.key)}
              className="sidebar-item"
              style={{
                display: 'flex', alignItems: 'center', gap: '6px', height: ROW_HEIGHT,
                padding: `0 10px 0 ${10 + row.depth * 12}px`, cursor: 'pointer', fontSize: '11px',
                boxSizing: 'border-box',
                background: selectedKey === row.item.key ? 'var(--win-bg-active)' : 'transparent',
              }}
            >
              <Key size={11} style={{ color: 'var(--win-text-disabled)', flexShrink: 0 }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--win-text-primary)' }} title={row.item.key}>
                {row.label || t('redis.emptySegment')}
              </span>
              {row.item.ttl >= 0 && (
                <span style={{ fontSize: '9px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '2px' }}>
                  <Clock size={9} />{ttlText(row.item.ttl)}
                </span>
              )}
              <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', color: '#fff', background: TYPE_COLORS[row.item.type] || '#64748b', textTransform: 'uppercase', flexShrink: 0 }}>
                {row.item.type}
              </span>
            </div>
          )
        ))}
        <div style={{ height: win.padBottom }} />
        {streaming && (
          <div style={{ padding: '10px', textAlign: 'center', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
            {t('redis.scanning', { n: keys.length.toLocaleString() })}
          </div>
        )}
      </div>

      {/* Chân panel giờ chỉ còn số lượng key: FLUSHDB chuyển lên cạnh bộ chọn db, còn
          Disconnect bỏ hẳn vì TitleBar đã có sẵn ở menu Connection và nút capsule. */}
      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--win-border)', fontSize: '10px', color: 'var(--win-text-disabled)' }}>
        {streaming
          ? t('redis.keyCountScanning', { n: keys.length.toLocaleString() })
          : typeFilter
            ? t('redis.keyCountFiltered', { n: keys.length.toLocaleString() })
            : t('redis.keyCount', { n: keys.length.toLocaleString() })}
      </div>
    </div>
  );
});
