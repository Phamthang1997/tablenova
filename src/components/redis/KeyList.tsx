import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Search, RefreshCw, Plus, Trash2, Key, Clock, Database, Square,
  ChevronRight, ChevronDown, FolderTree, List as ListIcon, Timer,
} from 'lucide-react';
import { dbHelper, type RedisKeyItem } from '../../utils/dbHelper';
import {
  buildKeyTree, flattenTree, allFolderPaths, folderMatchPattern, windowSlice, type TreeRow,
} from '../../utils/redisKeyTree';
import { clampMenu, type MenuRect } from '../../utils/menuPosition';
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

  // ---- Folder context menu ----
  // A namespace is the unit people actually think in (`post:*`, `session:*`), but until now the
  // only way to delete one was to retype its prefix into the bulk-delete dialog by hand.
  const [folderMenu, setFolderMenu] = useState<{
    x: number;
    y: number;
    /** Prefix including the trailing delimiter, i.e. `TreeRow.path`. */
    path: string;
    /** Keys under it *in the tree* — see the caveat where this is rendered. */
    count: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<MenuRect | null>(null);

  useLayoutEffect(() => {
    if (!folderMenu) {
      setMenuPos(null);
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos(clampMenu(folderMenu.x, folderMenu.y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [folderMenu]);

  useEffect(() => {
    const close = () => setFolderMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // Scrolling would leave the menu pinned to a row that is no longer under it.
  const onScrollList = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
    if (folderMenu) setFolderMenu(null);
  };

  /**
   * Hands the group to the existing bulk-delete dialog rather than deleting on the spot: that
   * dialog already carries the retype-to-confirm step, the live progress and the cancel button,
   * and this action can remove far more keys than the tree is showing.
   */
  const deleteFolder = (path: string) => {
    setFolderMenu(null);
    onBulkDelete(folderMatchPattern(path), typeFilter);
  };

  return (
    // Bề rộng, viền và nền đã chuyển lên `.redis-sidebar` (khung sidebar chứa nó) — ở đây chỉ
    // còn việc lấp đầy khung đó. `min-height: 0` là bắt buộc: không có nó, con cuộn bên trong một
    // flex column sẽ đẩy cao container thay vì tự cuộn.
    <div className="redis-keylist">
      <div className="redis-keylist-header">
        <div className="redis-keylist-row">
          <Database size={14} className="redis-keylist-db-icon" />
          <span className="redis-keylist-dbname">{dbName}</span>
          {/* FLUSHDB đứng cạnh bộ chọn database vì nó tác động lên đúng db đang chọn —
              đặt ở đây thì phạm vi của lệnh nằm ngay bên cạnh thứ quyết định phạm vi đó,
              và nó không nằm cạnh Refresh/New key là hai nút bấm liên tục. */}
          <button
            className="btn btn-secondary redis-icon-btn danger"
            onClick={onFlush}
            disabled={readOnly}
            title={t('redis.flushDbTitle')}
          >
            <Trash2 size={12} />
          </button>
          <select
            className="redis-keylist-select"
            value={dbIndex}
            onChange={(e) => onSelectDb(parseInt(e.target.value))}
            title={t('redis.dbIndexTitle')}
          >
            {Array.from({ length: 16 }, (_, i) => <option key={i} value={i}>db{i}</option>)}
          </select>
        </div>

        <div className="redis-keylist-row">
          <div className="redis-keylist-search">
            <Search size={12} className="redis-keylist-search-icon" />
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') refresh(); }}
              placeholder={t('redis.patternPlaceholder')}
            />
          </div>
          <select
            className="redis-keylist-select"
            value={typeFilter}
            onChange={(e) => onChangeTypeFilter(e.target.value)}
            title={t('redis.filterByTypeTitle')}
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

        <div className="redis-keylist-row tight">
          {streaming ? (
            <button className="btn btn-secondary redis-keylist-grow danger" onClick={stopScan}>
              <Square size={10} /> {t('redis.stopScan')}
            </button>
          ) : (
            <button className="btn btn-secondary redis-keylist-grow" onClick={refresh}>
              <RefreshCw size={11} /> {t('redis.refresh')}
            </button>
          )}
          <button className="btn btn-secondary redis-keylist-grow" onClick={onNewKey} disabled={readOnly}>
            <Plus size={11} /> {t('redis.newKey')}
          </button>
          <button
            className="btn btn-secondary redis-icon-btn danger"
            onClick={() => onBulkDelete(pattern, typeFilter)}
            disabled={readOnly}
            title={t('redis.bulkDeleteTitle')}
          >
            <Trash2 size={11} />
          </button>
        </div>

        <div className="redis-keylist-row tight">
          <button
            className="btn btn-secondary redis-keylist-mode"
            onClick={() => setTreeMode(!treeMode)}
            title={treeMode ? t('redis.viewFlatTitle') : t('redis.viewTreeTitle')}
          >
            {treeMode ? <FolderTree size={11} /> : <ListIcon size={11} />}
            {treeMode ? t('redis.viewTree') : t('redis.viewFlat')}
          </button>
          {treeMode && (
            <>
              <input
                className="redis-keylist-delim"
                type="text"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value)}
                title={t('redis.delimiterTitle')}
              />
              <button className="btn btn-secondary redis-keylist-step" onClick={expandAll} title={t('redis.expandAll')}><ChevronDown size={11} /></button>
              <button className="btn btn-secondary redis-keylist-step" onClick={collapseAll} title={t('redis.collapseAll')}><ChevronRight size={11} /></button>
            </>
          )}
          <div className="redis-keylist-spacer" />
          <Timer size={11} className="redis-keylist-search-icon" />
          <select
            className="redis-keylist-select"
            value={autoRefresh}
            onChange={(e) => setAutoRefresh(parseInt(e.target.value))}
            title={t('redis.autoRefreshTitle')}
          >
            {AUTO_REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === 0 ? t('redis.autoRefreshOff') : `${s}s`}</option>
            ))}
          </select>
        </div>
      </div>

      {capped && (
        // Never truncate silently: say what happened and offer to continue.
        <div className="redis-keylist-cap">
          <span>{t('redis.capReached', { n: keys.length.toLocaleString() })}</span>
          <button className="btn btn-secondary redis-keylist-cap-btn" onClick={loadMore}>
            {t('redis.loadMore')}
          </button>
        </div>
      )}

      <div ref={scrollRef} onScroll={onScrollList} className="redis-keylist-scroll">
        {rows.length === 0 && !streaming && (
          <div className="redis-keylist-empty">{t('redis.noKeyMatch')}</div>
        )}
        {/* Spacers keep the scrollbar proportional to the full list while only the window renders. */}
        <div style={{ height: win.padTop }} />
        {visible.map((row) => (
          row.kind === 'folder' ? (
            <div
              key={`f:${row.path}`}
              onClick={() => toggleFolder(row.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderMenu({ x: e.clientX, y: e.clientY, path: row.path, count: row.count });
              }}
              className="sidebar-item redis-row redis-row-folder"
              // Hai giá trị này phải ở inline vì chúng động theo từng dòng: độ thụt tính từ độ sâu
              // trong cây, và chiều cao PHẢI đúng bằng `ROW_HEIGHT` mà `windowSlice` dùng để tính
              // cửa sổ hiển thị. Để chiều cao trong CSS là mở đường cho hai con số lệch nhau, và
              // khi đó danh sách cuộn sai chỗ chứ không báo lỗi.
              style={{ '--redis-depth': row.depth, height: ROW_HEIGHT } as React.CSSProperties}
            >
              {row.expanded ? <ChevronDown size={11} className="redis-row-chevron" /> : <ChevronRight size={11} className="redis-row-chevron" />}
              <span className="redis-row-label folder">
                {row.label || t('redis.emptySegment')}
              </span>
              <span className="redis-row-count">{row.count.toLocaleString()}</span>
            </div>
          ) : (
            <div
              key={`k:${row.item.key}`}
              onClick={() => onSelectKey(row.item.key)}
              className={`sidebar-item redis-row${selectedKey === row.item.key ? ' selected' : ''}`}
              style={{ '--redis-depth': row.depth, height: ROW_HEIGHT } as React.CSSProperties}
            >
              <Key size={11} className="redis-row-chevron" />
              <span className="redis-row-label" title={row.item.key}>
                {row.label || t('redis.emptySegment')}
              </span>
              {row.item.ttl >= 0 && (
                <span className="redis-row-ttl">
                  <Clock size={9} />{ttlText(row.item.ttl)}
                </span>
              )}
              {/* Màu badge tra theo kiểu key nên phải ở inline — TYPE_COLORS là bảng trong TS,
                  nhân bản nó thành sáu class CSS là thêm một cặp phải giữ đồng bộ bằng tay. */}
              <span className="redis-row-type" style={{ background: TYPE_COLORS[row.item.type] || '#64748b' }}>
                {row.item.type}
              </span>
            </div>
          )
        ))}
        <div style={{ height: win.padBottom }} />
        {streaming && (
          <div className="redis-keylist-scanning">
            {t('redis.scanning', { n: keys.length.toLocaleString() })}
          </div>
        )}
      </div>

      {/* Rendered through a portal, like Modal.tsx: a `position: fixed` menu is measured against
          the nearest ancestor with a `backdrop-filter`, and the panel sits inside the app shell
          where several of those exist. */}
      {folderMenu && createPortal(
        <div
          ref={menuRef}
          className="ws-menu redis-folder-menu"
          // Toạ độ là kết quả đo lúc chạy nên buộc phải inline. `visibility` đi kèm ở đây chứ không
          // tách sang class: nó phụ thuộc đúng vào việc đã đo xong hay chưa, và tách ra thì hai thứ
          // luôn phải đổi cùng lúc.
          style={{
            top: menuPos ? menuPos.top : folderMenu.y,
            left: menuPos ? menuPos.left : folderMenu.x,
            // Hidden until measured, so the menu never visibly jumps into place.
            visibility: menuPos ? 'visible' : 'hidden',
          }}
        >
          <div className="redis-folder-menu-head">
            <div className="redis-folder-menu-path">{folderMenu.path}</div>
            {/* Labelled "shown" on purpose: this count comes from the tree, which the scan cap and
                the pattern/type filter can make smaller than what the prefix matches on the server.
                The item below therefore promises the prefix, not this number. */}
            <div className="redis-folder-menu-count">
              {t('redis.ctxFolderShown', { n: folderMenu.count.toLocaleString() })}
            </div>
          </div>
          <div
            onClick={(e) => { e.stopPropagation(); deleteFolder(folderMenu.path); }}
            className={`sidebar-context-item redis-folder-menu-item${readOnly ? ' disabled' : ''}`}
            title={readOnly ? t('redis.errReadOnly') : undefined}
          >
            <Trash2 size={11} /> {t('redis.ctxDeleteGroup')}
          </div>
        </div>,
        document.body,
      )}

      {/* Chân panel giờ chỉ còn số lượng key: FLUSHDB chuyển lên cạnh bộ chọn db, còn
          Disconnect bỏ hẳn vì TitleBar đã có sẵn ở menu Connection và nút capsule. */}
      <div className="redis-keylist-footer">
        {streaming
          ? t('redis.keyCountScanning', { n: keys.length.toLocaleString() })
          : typeFilter
            ? t('redis.keyCountFiltered', { n: keys.length.toLocaleString() })
            : t('redis.keyCount', { n: keys.length.toLocaleString() })}
      </div>
    </div>
  );
});
