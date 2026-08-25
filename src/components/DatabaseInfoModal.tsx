import React, { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { dbHelper, type DatabaseStats, type AllDatabasesStats, type AllDatabasesSizeItem } from '../utils/dbHelper';
import { RefreshCw, HardDrive, Hash, Table, Search, ArrowUpDown, ExternalLink, ShieldCheck, Database, Server, ScanSearch, Lock, Layers, Eye, Braces, Cog, ChevronRight, ChevronDown } from 'lucide-react';
import { Modal, ModalFooter } from './Modal';

type InfoTab = 'current' | 'all';
/** Nhóm đối tượng currently xem in tab "Database hiện tại". */
type ObjKind = 'table' | 'view' | 'function' | 'procedure';

/**
 * Caches the "all databases" tab per connection, so reopening the modal shows numbers at
 * once instead of re-running the most expensive query in the dialog. The TTL is short
 * because these are live figures (and "refresh" always bypasses the cache); keying on
 * `connId` keeps another server's numbers out.
 */
const ALL_STATS_TTL_MS = 60_000;
const allStatsCache = new Map<string, { at: number; stats: AllDatabasesStats }>();

/**
 * How many table rows are rendered before the list is capped. A row is ~10 elements with a
 * button, so a 2000-table database would otherwise build ~20k DOM nodes on every render of
 * this dialog. Above the cap the user gets a count and a "show all" escape hatch — the
 * search box narrows the list far below it anyway.
 */
const TABLE_ROW_CAP = 500;

/**
 * Merges phase 2's numbers onto phase 1's result. Rows match on `schema_name` first, then
 * `db_name`; every field is written only when phase 2 actually has a number (`??`), so a
 * null can never overwrite what phase 1 already knew.
 */
const mergeSizes = (base: AllDatabasesStats, items: AllDatabasesSizeItem[]): AllDatabasesStats => {
  const byKey = new Map<string, AllDatabasesSizeItem>();
  for (const it of items) {
    const k = it.schema_name || it.db_name;
    if (k) byKey.set(k, it);
  }

  return {
    ...base,
    metrics_pending: false,
    databases: base.databases.map((d) => {
      const m = byKey.get(d.schema_name || d.db_name);
      if (!m) {
        // An empty database is absent from phase 2's per-table aggregate (MySQL GROUP BY
        // over information_schema.TABLES), yet its numbers are known: zero. A database
        // phase 2 skipped (a hidden system schema) keeps its nulls and renders as "-".
        if (d.total_tables === 0) {
          return {
            ...d,
            total_rows: d.total_rows ?? 0,
            data_size_bytes: d.data_size_bytes ?? 0,
            index_size_bytes: d.index_size_bytes ?? 0,
            total_size_bytes: d.total_size_bytes ?? 0,
          };
        }
        return d;
      }
      return {
        ...d,
        total_tables: m.total_tables ?? d.total_tables,
        total_rows: m.total_rows ?? d.total_rows,
        data_size_bytes: m.data_size_bytes ?? d.data_size_bytes,
        index_size_bytes: m.index_size_bytes ?? d.index_size_bytes,
        total_size_bytes: m.total_size_bytes ?? d.total_size_bytes,
        error: m.error ?? d.error,
      };
    }),
  };
};

interface DatabaseInfoModalProps {
  /** Kết nối mà component này thao tác lên. Truyền tường minh, not read id ambient (§4.1). */
  connId: string;
  isOpen: boolean;
  onClose: () => void;
  onSelectTable: (tableName: string) => void;
  /** Tab open sẵn when bật modal (ando from menu "Thống kê all database" thì is 'all'). */
  initialTab?: InfoTab;
  /** Gọi sau when đổi database successful, to App load lại cây table + tab. */
  /** Xem write chú cùng tên at `Sidebar.tsx`: open add kết nối, not thay pool tại chỗ. */
  onDatabaseOpened?: (connId: string, name: string, schema?: string | null) => void;
}

export const DatabaseInfoModal: React.FC<DatabaseInfoModalProps> = ({
  connId,
  isOpen,
  onClose,
  onSelectTable,
  initialTab = 'current',
  onDatabaseOpened,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<InfoTab>(initialTab);
  const [stats, setStats] = useState<DatabaseStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  /**
   * The list filters on the deferred value, the input renders the live one: on a database
   * with a couple of thousand tables, filtering + reconciling every row on each keystroke is
   * what makes typing feel stuck. React keeps the input responsive and lets the heavy list
   * lag a frame behind instead.
   */
  const deferredSearch = useDeferredValue(searchTerm);
  /** "Show all" was pressed, so `TABLE_ROW_CAP` no longer applies. */
  const [showAllTables, setShowAllTables] = useState(false);
  const [sortBy, setSortBy] = useState<'size_desc' | 'rows_desc' | 'name_asc'>('size_desc');
  const [exactCounts, setExactCounts] = useState<Record<string, number>>({});
  const [countingTable, setCountingTable] = useState<string | null>(null);

  // View / hàm / thủ tục of database hiện tại (dùng chung nguồn with Sidebar)
  const [objects, setObjects] = useState<{ views: string[]; functions: string[]; procedures: string[] } | null>(null);
  const [objKind, setObjKind] = useState<ObjKind>('table');
  const [expandedObj, setExpandedObj] = useState<string | null>(null);
  const [objDefs, setObjDefs] = useState<Record<string, string>>({});
  const [loadingDef, setLoadingDef] = useState<string | null>(null);

  // Tab "all Database"
  const [allStats, setAllStats] = useState<AllDatabasesStats | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const [allSearch, setAllSearch] = useState('');
  const [allSortBy, setAllSortBy] = useState<'size_desc' | 'tables_desc' | 'rows_desc' | 'name_asc'>('size_desc');
  const [showSystemDbs, setShowSystemDbs] = useState(false);
  const [switchingDb, setSwitchingDb] = useState<string | null>(null);
  /** Phase 2 (sizes / row counts) is running in the background — the list is already up. */
  const [metricsLoading, setMetricsLoading] = useState(false);
  /**
   * Token of the current "all databases" load. Phase 2 runs in the background, so it can
   * land after the modal was closed or refresh was pressed; a stale result must be dropped
   * rather than merged.
   */
  const allReqRef = useRef(0);

  const fetchStats = async () => {
    setLoading(true);
    setError(null);
    const [res, objs] = await Promise.all([dbHelper.getDatabaseStats(connId), dbHelper.getDatabaseObjects(connId)]);
    setLoading(false);
    setObjects({ views: objs.views, functions: objs.functions, procedures: objs.procedures });
    if (res.success && res.stats) {
      setStats(res.stats);
    } else {
      setError(res.error || t('dbInfo.errStats'));
    }
  };

  // Định nghĩa SQL of view/hàm/thủ tục: load when expand lần đầu rồi giữ lại.
  const toggleObjectDef = async (name: string, kind: Exclude<ObjKind, 'table'>) => {
    const key = `${kind}:${name}`;
    if (expandedObj === key) {
      setExpandedObj(null);
      return;
    }
    setExpandedObj(key);
    if (objDefs[key] !== undefined) return;
    setLoadingDef(key);
    const res = await dbHelper.getObjectDefinition(connId, name, kind);
    setLoadingDef(null);
    setObjDefs((prev) => ({
      ...prev,
      [key]: res.success && res.sql ? res.sql : (res.error || t('dbInfo.errDefinition')),
    }));
  };

  // Phase 2: sizes / row counts. Runs after the list is on screen and blocks nothing.
  const fetchMetrics = async (req: number, base: AllDatabasesStats, includeSystem: boolean) => {
    setMetricsLoading(true);
    const res = await dbHelper.getAllDatabasesSizes(connId, includeSystem);
    if (req !== allReqRef.current) return;
    setMetricsLoading(false);
    if (res.success && res.items) {
      const merged = mergeSizes(base, res.items);
      setAllStats(merged);
      allStatsCache.set(connId, { at: Date.now(), stats: merged });
    } else {
      setAllError(res.error || t('dbInfo.errAllStats'));
    }
  };

  const fetchAllStats = async (force = false) => {
    // Bumping the token cancels an in-flight phase 2, so its flag has to go down with it.
    const req = ++allReqRef.current;
    setMetricsLoading(false);

    if (!force) {
      const hit = allStatsCache.get(connId);
      if (hit && Date.now() - hit.at < ALL_STATS_TTL_MS) {
        setAllStats(hit.stats);
        setAllError(null);
        if (hit.stats.metrics_pending && !hit.stats.metrics_manual) {
          fetchMetrics(req, hit.stats, showSystemDbs);
        }
        return;
      }
    }

    setAllLoading(true);
    setAllError(null);
    const res = await dbHelper.getAllDatabasesStats(connId);
    if (req !== allReqRef.current) return;
    setAllLoading(false);
    if (res.success && res.stats) {
      setAllStats(res.stats);
      allStatsCache.set(connId, { at: Date.now(), stats: res.stats });
      // Postgres needs a connection per database to count, so it waits for "deep scan".
      if (res.stats.metrics_pending && !res.stats.metrics_manual) {
        fetchMetrics(req, res.stats, showSystemDbs);
      }
    } else {
      setAllError(res.error || t('dbInfo.errAllStats'));
    }
  };

  // Reopening the modal always loads the requested tab; closing it clears state so the next
  // open cannot show figures of a database that has since changed. The "all databases" tab
  // is the exception: it reads `allStatsCache` (60s TTL, keyed by connId), so reopening
  // within a minute is instant instead of re-running the dialog's most expensive query.
  useEffect(() => {
    if (!isOpen) {
      // Phase 2 may still be running: bump the token so its result gets dropped.
      allReqRef.current++;
      setMetricsLoading(false);
      setStats(null);
      setAllStats(null);
      setExactCounts({});
      setError(null);
      setAllError(null);
      setObjects(null);
      setObjKind('table');
      setExpandedObj(null);
      setObjDefs({});
      setShowAllTables(false);
      return;
    }
    setTab(initialTab);
    if (initialTab === 'all') fetchAllStats();
    else fetchStats();
    // fetchStats/fetchAllStats close over `t`, whose identity changes on every
    // language switch. Listing them here would refetch the whole statistics set
    // just because the UI language changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialTab]);

  // Chuyển tab: chỉ load when tab đó chưa có dữ liệu (tránh gọi lại mỗi lần bấm qua lại).
  const selectTab = (next: InfoTab) => {
    setTab(next);
    if (next === 'current' && !stats && !loading) fetchStats();
    if (next === 'all' && !allStats && !allLoading) fetchAllStats();
  };

  // Ticking "show system DBs" after phase 2 already ran: those schemas were skipped to save
  // a few hundred table opens, so their numbers have to be fetched now.
  const handleToggleSystemDbs = (checked: boolean) => {
    setShowSystemDbs(checked);
    // A still-true `metrics_pending` means phase 2 has not finished (on Postgres it is
    // waiting for "deep scan") — let that path handle it instead of racing a second one.
    if (!checked || !allStats || allStats.metrics_pending || metricsLoading) return;
    if (allStats.databases.some((d) => d.is_system && (d.total_rows === null || d.total_tables === null))) {
      fetchMetrics(allReqRef.current, allStats, true);
    }
  };

  const handleSwitchDatabase = async (name: string) => {
    if (allStats && name === allStats.current_db) return;
    setSwitchingDb(name);
    const res = await dbHelper.openDatabase(connId, name);
    setSwitchingDb(null);
    if (res.success && res.connId) {
      onDatabaseOpened?.(res.connId, res.database || name, res.schema);
      onClose();
    } else {
      setAllError(t('dbInfo.errOpenDb', { message: res.error || '' }));
    }
  };

  const handleFetchExactCount = async (tableName: string) => {
    setCountingTable(tableName);
    const res = await dbHelper.getExactTableRowCount(connId, tableName);
    setCountingTable(null);
    if (res.success && res.exact_rows !== undefined) {
      setExactCounts((prev) => ({ ...prev, [tableName]: Math.max(0, res.exact_rows!) }));
    }
  };

  const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '-';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const filteredTables = useMemo(() => {
    if (!stats?.tables) return [];
    // Not named `t` — that is the translation function.
    let list = stats.tables.filter((tbl) =>
      tbl.table_name.toLowerCase().includes(deferredSearch.toLowerCase().trim())
    );

    return [...list].sort((a, b) => {
      if (sortBy === 'size_desc') {
        const sizeA = a.total_size_bytes ?? 0;
        const sizeB = b.total_size_bytes ?? 0;
        return sizeB - sizeA;
      }
      if (sortBy === 'rows_desc') {
        const rowsA = Math.max(0, exactCounts[a.table_name] ?? a.rows);
        const rowsB = Math.max(0, exactCounts[b.table_name] ?? b.rows);
        return rowsB - rowsA;
      }
      return a.table_name.localeCompare(b.table_name);
    });
  }, [stats, deferredSearch, sortBy, exactCounts]);

  // Danh sách view/hàm/thủ tục theo nhóm currently select (dùng chung ô search with table).
  const currentObjects = useMemo(() => {
    if (!objects || objKind === 'table') return [];
    const src =
      objKind === 'view' ? objects.views : objKind === 'function' ? objects.functions : objects.procedures;
    const q = deferredSearch.toLowerCase().trim();
    return [...src].filter((n) => n.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  }, [objects, objKind, deferredSearch]);

  // Only the rows actually rendered. Everything else (counts, the notice) reads
  // `filteredTables`, so capping never changes what the dialog claims to have found.
  const visibleTables = useMemo(
    () => (showAllTables ? filteredTables : filteredTables.slice(0, TABLE_ROW_CAP)),
    [filteredTables, showAllTables]
  );

  const objectCounts = useMemo(
    () => ({
      view: objects?.views.length ?? 0,
      function: objects?.functions.length ?? 0,
      procedure: objects?.procedures.length ?? 0,
    }),
    [objects]
  );

  // Tập database currently xét: chỉ filter theo "DB hệ thống". Mọi con số tổng (kể cả tiêu đề
  // and tên tab) đều đếm on tập này to not lệch nhau; ô search chỉ filter row in table.
  const scopedDatabases = useMemo(
    () => (allStats?.databases || []).filter((d) => showSystemDbs || !d.is_system),
    [allStats, showSystemDbs]
  );

  // Danh sách display in table: tập on + search + sort.
  const visibleDatabases = useMemo(() => {
    const list = scopedDatabases.filter((d) =>
      d.db_name.toLowerCase().includes(allSearch.toLowerCase().trim())
    );

    // Always tie-break by name: before phase 2 lands every numeric key is equal, and an
    // alphabetical list reads better than whatever incidental order the server returned.
    return [...list].sort((a, b) => {
      if (allSortBy === 'size_desc' && a.total_size_bytes !== b.total_size_bytes)
        return (b.total_size_bytes ?? 0) - (a.total_size_bytes ?? 0);
      if (allSortBy === 'tables_desc' && a.total_tables !== b.total_tables)
        return (b.total_tables ?? -1) - (a.total_tables ?? -1);
      if (allSortBy === 'rows_desc' && a.total_rows !== b.total_rows)
        return (b.total_rows ?? -1) - (a.total_rows ?? -1);
      return a.db_name.localeCompare(b.db_name);
    });
  }, [scopedDatabases, allSearch, allSortBy]);

  // Tổng of các database currently xét (đổi theo bộ filter "DB hệ thống", not đổi theo search).
  const serverSummary = useMemo(() => {
    let size = 0;
    let tables = 0;
    let rows = 0;
    let hasUnknown = false;
    for (const d of scopedDatabases) {
      size += d.total_size_bytes ?? 0;
      if (d.total_tables === null || d.total_rows === null) hasUnknown = true;
      tables += d.total_tables ?? 0;
      rows += d.total_rows ?? 0;
    }
    return { size, tables, rows, count: scopedDatabases.length, hasUnknown };
  }, [scopedDatabases]);

  const systemDbCount = useMemo(
    () => (allStats?.databases || []).filter((d) => d.is_system).length,
    [allStats]
  );

  // A background phase 2 counts as "loading" too: the refresh button spins and stays
  // disabled, which is the only cue that the "…" cells are about to get numbers.
  const busy = tab === 'all' ? allLoading || metricsLoading : loading;

  /** A number cell of the "all databases" tab: "…" while phase 2 runs, "-" if unmeasurable. */
  const metricCell = (v: number | null, render: (n: number) => string) =>
    v === null ? (metricsLoading ? '…' : '-') : render(v);

  if (!isOpen) return null;

  const headerTitle = tab === 'all' ? (
    <Trans
      i18nKey="dbInfo.titleAll"
      values={{ n: allStats ? scopedDatabases.length : '...' }}
      components={{ accent: <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600 }} /> }}
    />
  ) : (
    <Trans
      i18nKey="dbInfo.titleCurrent"
      values={{ name: stats?.db_name || '...' }}
      components={{ accent: <span style={{ color: 'var(--win-accent)', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600 }} /> }}
    />
  );

  return (
    <Modal
      title={headerTitle}
      icon={tab === 'all'
        ? <Server size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />
        : <HardDrive size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="1100px"
      maxWidth="95%"
      height="85vh"
      zIndex={9999}
      cardStyle={{ color: 'var(--win-text-primary)', fontFamily: 'var(--win-font-sans, system-ui, sans-serif)' }}
      headerExtra={
        <span
          title={t('dbInfo.dbTypeLabel')}
          style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--win-accent)', background: 'var(--win-accent-glow)', border: '1px solid var(--win-border)', padding: '1px 8px', borderRadius: '4px', letterSpacing: '0.05em' }}
        >
          {(tab === 'all' ? allStats?.db_type : stats?.db_type) || '-'}
        </span>
      }
    >
        {/* Segmented tabs: database hiện tại ↔ toàn bộ database on server.
            Nút Refresh nằm at row này thay vì on title bar, to header
            cao đúng bằng mọi dialog khác (xem `Modal.tsx`). */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', padding: '10px 24px 0', borderBottom: '1px solid var(--win-border)', background: 'var(--win-bg-tab-bar)' }}>
          {([
            {
              key: 'current' as const,
              icon: <Database size={13} />,
              label: stats?.db_name ? t('dbInfo.tabCurrentNamed', { name: stats.db_name }) : t('dbInfo.tabCurrent'),
            },
            {
              key: 'all' as const,
              icon: <Server size={13} />,
              label: allStats ? t('dbInfo.tabAllCount', { n: scopedDatabases.length }) : t('dbInfo.tabAll'),
            },
            // Not named `t` — that is the translation function.
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => selectTab(item.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '9px 16px',
                fontSize: '12px',
                fontWeight: tab === item.key ? 600 : 500,
                color: tab === item.key ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                background: 'transparent',
                border: 'none',
                borderBottom: `2px solid ${tab === item.key ? 'var(--win-accent)' : 'transparent'}`,
                marginBottom: '-1px',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
          <button
            className="btn btn-secondary"
            onClick={() => (tab === 'all' ? fetchAllStats(true) : fetchStats())}
            disabled={busy}
            title={t('dbInfo.refreshTitle')}
            style={{ marginLeft: 'auto', marginBottom: '8px', padding: '0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={13} className={busy ? 'loading-spinner' : ''} />
            <span>{busy ? t('dbInfo.loading') : t('dbInfo.refresh')}</span>
          </button>
        </div>

        {/* Content Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {tab === 'current' && (<>
          {error && (
            <div style={{ padding: '12px 16px', background: 'var(--win-status-deleted)', border: '1px solid var(--win-status-deleted-border)', borderRadius: '6px', color: 'var(--win-status-deleted-border)', fontSize: '13px' }}>
              {error}
            </div>
          )}

          {/* Overview Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
            {/* Card 1: Total Size */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardSize')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{formatBytes(stats?.total_size_bytes)}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-accent-glow)', color: 'var(--win-accent)', display: 'flex' }}>
                <HardDrive size={22} />
              </div>
            </div>

            {/* Card 2: Total Rows */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardRows')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {stats?.total_rows !== undefined ? Math.max(0, stats.total_rows).toLocaleString() : '-'}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-status-added)', color: 'var(--win-status-added-border)', display: 'flex' }}>
                <Hash size={22} />
              </div>
            </div>

            {/* Card 3: Total Tables */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardTables')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{stats?.total_tables ?? 0}</div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', display: 'flex' }}>
                <Table size={22} />
              </div>
            </div>

            {/* Card 4: View / hàm / thủ tục */}
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardOther')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {objectCounts.view + objectCounts.function + objectCounts.procedure}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', marginTop: '2px' }}>
                  {t('dbInfo.otherBreakdown', {
                    views: objectCounts.view,
                    functions: objectCounts.function,
                    procedures: objectCounts.procedure,
                  })}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', display: 'flex' }}>
                <Layers size={22} />
              </div>
            </div>
          </div>

          {/* select nhóm đối tượng to liệt kê bên under */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {([
              { key: 'table' as const, icon: <Table size={12} />, label: t('dbInfo.kindTable'), count: stats?.total_tables ?? 0 },
              { key: 'view' as const, icon: <Eye size={12} />, label: t('dbInfo.kindView'), count: objectCounts.view },
              { key: 'function' as const, icon: <Braces size={12} />, label: t('dbInfo.kindFunction'), count: objectCounts.function },
              { key: 'procedure' as const, icon: <Cog size={12} />, label: t('dbInfo.kindProcedure'), count: objectCounts.procedure },
            ]).map((k) => (
              <button
                key={k.key}
                onClick={() => { setObjKind(k.key); setExpandedObj(null); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  fontWeight: objKind === k.key ? 600 : 500,
                  borderRadius: '999px',
                  cursor: 'pointer',
                  color: objKind === k.key ? 'var(--win-accent)' : 'var(--win-text-secondary)',
                  background: objKind === k.key ? 'var(--win-accent-glow)' : 'var(--win-bg-window)',
                  border: `1px solid ${objKind === k.key ? 'var(--win-accent)' : 'var(--win-border)'}`,
                }}
              >
                {k.icon}
                <span>{k.label}</span>
                <span style={{ fontFamily: 'var(--win-font-mono, monospace)', opacity: 0.75 }}>{k.count}</span>
              </button>
            ))}
          </div>

          {/* Search & Sorting Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: '300px' }}>
              <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-disabled)' }} />
              <input
                type="text"
                placeholder={objKind === 'table' ? t('dbInfo.searchTables') : t('dbInfo.searchObjects')}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '6px',
                  paddingLeft: '34px',
                  paddingRight: '12px',
                  paddingTop: '8px',
                  paddingBottom: '8px',
                  fontSize: '12px',
                  color: 'var(--win-text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* View/hàm/thủ tục not có dung lượng hay số row nên luôn xếp theo tên */}
            {objKind === 'table' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
                <ArrowUpDown size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <select
                  value={sortBy}
                  onChange={(e: any) => setSortBy(e.target.value)}
                  style={{
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    fontSize: '12px',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="size_desc">{t('dbInfo.sortSizeDesc')}</option>
                  <option value="rows_desc">{t('dbInfo.sortRowsDesc')}</option>
                  <option value="name_asc">{t('dbInfo.sortNameAsc')}</option>
                </select>
              </div>
            )}
          </div>

          {/* Table List Data Grid */}
          <div style={{ flex: 1, border: '1px solid var(--win-border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ overflowX: 'auto', flex: 1 }}>
              {objKind === 'table' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    <th style={{ padding: '12px 16px' }}>{t('dbInfo.colTableName')}</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>{t('dbInfo.colRows')}</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Data Size</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>Index Size</th>
                    <th style={{ padding: '12px 16px', textAlign: 'right' }}>{t('dbInfo.colTotalSize')}</th>
                    <th style={{ padding: '12px 16px', textAlign: 'center' }}>Engine</th>
                    <th style={{ padding: '12px 16px', textAlign: 'center' }}>{t('dbInfo.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--win-text-secondary)' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontSize: '13px', fontWeight: 500 }}>
                          <RefreshCw size={18} className="loading-spinner" style={{ color: 'var(--win-accent)' }} />
                          <span>{t('dbInfo.loadingStats')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredTables.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--win-text-disabled)' }}>
                        {t('dbInfo.noTableMatch')}
                      </td>
                    </tr>
                  ) : (
                    visibleTables.map((row) => {
                      const isExact = exactCounts[row.table_name] !== undefined || row.is_exact;
                      const rawRows = exactCounts[row.table_name] ?? row.rows;
                      const displayRows = Math.max(0, rawRows);
                      const isCounting = countingTable === row.table_name;

                      return (
                        <tr key={row.table_name} className="stat-row">
                          <td style={{ padding: '10px 16px', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-accent)' }}>
                            {row.table_name}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-primary)' }}>
                            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              {!isExact && <span style={{ color: 'var(--win-text-disabled)', fontFamily: 'sans-serif' }}>~</span>}
                              <span>{displayRows.toLocaleString()}</span>
                              {!isExact && (
                                <button
                                  onClick={() => handleFetchExactCount(row.table_name)}
                                  disabled={isCounting}
                                  title={t('dbInfo.exactCountTitle')}
                                  style={{
                                    background: 'var(--win-bg-hover)',
                                    border: '1px solid var(--win-border)',
                                    color: 'var(--win-text-secondary)',
                                    cursor: isCounting ? 'default' : 'pointer',
                                    padding: '2px 5px',
                                    borderRadius: '4px',
                                    display: 'inline-flex',
                                  }}
                                >
                                  <RefreshCw size={12} className={isCounting ? 'loading-spinner' : ''} style={{ color: isCounting ? 'var(--win-accent)' : undefined }} />
                                </button>
                              )}
                              {isExact && (
                                <span title={t('dbInfo.exactRowsTitle')}>
                                  <ShieldCheck size={14} style={{ color: 'var(--win-status-added-border, #10b981)', verticalAlign: 'middle' }} />
                                </span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)' }}>
                            {formatBytes(row.data_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)' }}>
                            {formatBytes(row.index_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                            {formatBytes(row.total_size_bytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                            <span style={{ padding: '2px 8px', fontSize: '11px', fontWeight: 500, background: 'var(--win-bg-tab-bar)', borderRadius: '4px', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                              {row.engine || '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                            <button
                              onClick={() => {
                                onSelectTable(row.table_name);
                                onClose();
                              }}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '5px',
                                fontSize: '11px',
                                fontWeight: 500,
                                color: '#ffffff',
                                background: 'var(--win-accent)',
                                border: 'none',
                                padding: '5px 12px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                                flexShrink: 0,
                              }}
                            >
                              <span>{t('dbInfo.viewData')}</span>
                              <ExternalLink size={12} />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                  {visibleTables.length < filteredTables.length && (
                    <tr>
                      <td colSpan={7} style={{ padding: '14px 16px', textAlign: 'center', color: 'var(--win-text-secondary)', background: 'var(--win-bg-tab-bar)' }}>
                        <span>{t('dbInfo.rowCapNotice', { n: visibleTables.length, total: filteredTables.length })}</span>
                        <button
                          className="btn btn-secondary"
                          onClick={() => setShowAllTables(true)}
                          style={{ marginLeft: '10px', padding: '0 12px' }}
                        >
                          {t('dbInfo.showAllRows')}
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              ) : (
              /* View / hàm / thủ tục: chỉ có tên + định nghĩa, bấm to xem SQL */
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                    <th style={{ padding: '12px 16px' }}>
                      {objKind === 'view' ? t('dbInfo.colViewName') : objKind === 'function' ? t('dbInfo.colFunctionName') : t('dbInfo.colProcedureName')}
                    </th>
                    <th style={{ padding: '12px 16px', width: '260px', textAlign: 'center' }}>{t('dbInfo.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={2} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--win-text-secondary)' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontSize: '13px', fontWeight: 500 }}>
                          <RefreshCw size={18} className="loading-spinner" style={{ color: 'var(--win-accent)' }} />
                          <span>{t('dbInfo.loadingObjects')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : currentObjects.length === 0 ? (
                    <tr>
                      <td colSpan={2} style={{ textAlign: 'center', padding: '40px', color: 'var(--win-text-disabled)' }}>
                        {objKind === 'view' ? t('dbInfo.noViews') : objKind === 'function' ? t('dbInfo.noFunctions') : t('dbInfo.noProcedures')}
                      </td>
                    </tr>
                  ) : (
                    currentObjects.map((name) => {
                      const key = `${objKind}:${name}`;
                      const isExpanded = expandedObj === key;
                      const isLoadingDef = loadingDef === key;

                      return (
                        <React.Fragment key={key}>
                          <tr className="stat-row">
                            <td style={{ padding: '10px 16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                <span style={{ color: 'var(--win-text-disabled)', display: 'flex', flexShrink: 0 }}>
                                  {objKind === 'view' ? <Eye size={13} /> : objKind === 'function' ? <Braces size={13} /> : <Cog size={13} />}
                                </span>
                                <span title={name} style={{ fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {name}
                                </span>
                              </div>
                            </td>
                            <td style={{ padding: '10px 16px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                <button
                                  onClick={() => toggleObjectDef(name, objKind)}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                                    fontSize: '11px', fontWeight: 500,
                                    color: 'var(--win-text-secondary)', background: 'var(--win-bg-hover)',
                                    border: '1px solid var(--win-border)', padding: '5px 10px',
                                    borderRadius: '4px', cursor: 'pointer',
                                  }}
                                >
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  <span>{t('dbInfo.definition')}</span>
                                </button>
                                {objKind === 'view' && (
                                  <button
                                    onClick={() => { onSelectTable(name); onClose(); }}
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: '5px',
                                      fontSize: '11px', fontWeight: 500, color: '#ffffff',
                                      background: 'var(--win-accent)', border: 'none',
                                      padding: '5px 12px', borderRadius: '4px', cursor: 'pointer',
                                    }}
                                  >
                                    <span>{t('dbInfo.viewData')}</span>
                                    <ExternalLink size={12} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr style={{ borderBottom: '1px solid var(--win-border)' }}>
                              <td colSpan={2} style={{ padding: '0 16px 12px' }}>
                                <pre style={{
                                  margin: 0,
                                  maxHeight: '260px',
                                  overflow: 'auto',
                                  padding: '12px 14px',
                                  background: 'var(--win-bg-tab-bar)',
                                  border: '1px solid var(--win-border)',
                                  borderRadius: '6px',
                                  fontFamily: 'var(--win-font-mono, monospace)',
                                  fontSize: '11px',
                                  lineHeight: 1.55,
                                  color: 'var(--win-text-primary)',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}>
                                  {isLoadingDef ? t('dbInfo.loadingDefinition') : objDefs[key]}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
              )}
            </div>
          </div>
          </>)}

          {tab === 'all' && (<>
          {allError && (
            <div style={{ padding: '12px 16px', background: 'var(--win-status-deleted)', border: '1px solid var(--win-status-deleted-border)', borderRadius: '6px', color: 'var(--win-status-deleted-border)', fontSize: '13px' }}>
              {allError}
            </div>
          )}

          {/* Server Summary Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardServerSize')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {metricsLoading ? '…' : formatBytes(serverSummary.size)}
                </div>
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-accent-glow)', color: 'var(--win-accent)', display: 'flex' }}>
                <HardDrive size={22} />
              </div>
            </div>

            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardDbCount')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>{serverSummary.count}</div>
                {systemDbCount > 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', marginTop: '2px' }}>
                    {showSystemDbs
                      ? t('dbInfo.includingSystemDbs', { n: systemDbCount })
                      : t('dbInfo.hidingSystemDbs', { n: systemDbCount })}
                  </div>
                )}
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', display: 'flex' }}>
                <Server size={22} />
              </div>
            </div>

            <div style={{ padding: '16px 20px', borderRadius: '8px', background: 'var(--win-bg-window)', border: '1px solid var(--win-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '12px', color: 'var(--win-text-secondary)', fontWeight: 500, marginBottom: '4px' }}>{t('dbInfo.cardTablesRows')}</div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--win-text-primary)' }}>
                  {serverSummary.tables.toLocaleString()}
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--win-text-secondary)' }}>
                    {' / '}
                    {metricsLoading
                      ? '…'
                      : `${allStats?.rows_are_exact === false ? '~' : ''}${serverSummary.rows.toLocaleString()}`}
                  </span>
                </div>
                {serverSummary.hasUnknown && !metricsLoading && (
                  <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)', marginTop: '2px' }}>{t('dbInfo.incompleteScan')}</div>
                )}
              </div>
              <div style={{ padding: '12px', borderRadius: '8px', background: 'var(--win-status-added)', color: 'var(--win-status-added-border)', display: 'flex' }}>
                <Hash size={22} />
              </div>
            </div>
          </div>

          {/* Postgres: metadata số table/số row read-only is from chính database currently kết nối */}
          {allStats?.metrics_manual && allStats.metrics_pending && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', background: 'var(--win-bg-window)', border: '1px dashed var(--win-border)', borderRadius: '8px', fontSize: '12px', color: 'var(--win-text-secondary)' }}>
              <ScanSearch size={16} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>
                {t('dbInfo.pgScanNote')}
              </span>
              <button
                onClick={() => fetchMetrics(allReqRef.current, allStats, showSystemDbs)}
                disabled={busy}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px', flexShrink: 0,
                  fontSize: '12px', fontWeight: 500, color: '#ffffff', background: 'var(--win-accent)',
                  border: 'none', padding: '7px 14px', borderRadius: '6px',
                  cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                }}
              >
                <ScanSearch size={13} />
                <span>{busy ? t('dbInfo.scanning') : t('dbInfo.deepScan')}</span>
              </button>
            </div>
          )}

          {/* Search & Sorting Bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: '300px' }}>
              <Search size={14} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-disabled)' }} />
              <input
                type="text"
                placeholder={t('dbInfo.searchDatabases')}
                value={allSearch}
                onChange={(e) => setAllSearch(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--win-bg-window)',
                  border: '1px solid var(--win-border)',
                  borderRadius: '6px',
                  paddingLeft: '34px',
                  paddingRight: '12px',
                  paddingTop: '8px',
                  paddingBottom: '8px',
                  fontSize: '12px',
                  color: 'var(--win-text-primary)',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginLeft: 'auto' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--win-text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showSystemDbs} onChange={(e) => handleToggleSystemDbs(e.target.checked)} />
                <span>{t('dbInfo.showSystemDbs')}</span>
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ArrowUpDown size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <select
                  value={allSortBy}
                  onChange={(e: any) => setAllSortBy(e.target.value)}
                  style={{
                    background: 'var(--win-bg-window)',
                    border: '1px solid var(--win-border)',
                    color: 'var(--win-text-primary)',
                    fontSize: '12px',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  <option value="size_desc">{t('dbInfo.sortSizeDesc')}</option>
                  <option value="tables_desc">{t('dbInfo.sortTablesDesc')}</option>
                  <option value="rows_desc">{t('dbInfo.sortRowsDesc')}</option>
                  <option value="name_asc">{t('dbInfo.sortDbNameAsc')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Database Comparison Grid */}
          <div style={{ flex: 1, border: '1px solid var(--win-border)', borderRadius: '8px', overflow: 'hidden', background: 'var(--win-bg-window)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ overflowX: 'auto', flex: 1 }}>
              {/* table-layout fixed: chia column theo tỉ lệ định sẵn, not to trình duyệt tự
                  co kéo (thanh bar co giãn is will nuốt hết chỗ and ism các column số newline).
                  minWidth to window hẹp thì cuộn ngang thay vì bóp nát các column. */}
              <table style={{ width: '100%', minWidth: '860px', tableLayout: 'fixed', borderCollapse: 'collapse', textAlign: 'left', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--win-bg-tab-bar)', borderBottom: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                    <th style={{ padding: '12px 16px', width: '17%' }}>Database</th>
                    <th style={{ padding: '12px 16px', width: '20%' }}>{t('dbInfo.colSizeShare')}</th>
                    <th style={{ padding: '12px 16px', width: '12%', textAlign: 'right' }}>{t('dbInfo.colSize')}</th>
                    <th style={{ padding: '12px 16px', width: '10%', textAlign: 'right' }}>{t('dbInfo.colTables')}</th>
                    <th style={{ padding: '12px 16px', width: '13%', textAlign: 'right' }}>{t('dbInfo.colRows')}</th>
                    <th style={{ padding: '12px 16px', width: '13%' }}>{t('dbInfo.colEncoding')}</th>
                    <th style={{ padding: '12px 16px', width: '15%', textAlign: 'center' }}>{t('dbInfo.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {allLoading ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--win-text-secondary)' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontSize: '13px', fontWeight: 500 }}>
                          <RefreshCw size={18} className="loading-spinner" style={{ color: 'var(--win-accent)' }} />
                          <span>{t('dbInfo.loadingAllStats')}</span>
                        </div>
                      </td>
                    </tr>
                  ) : visibleDatabases.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: 'var(--win-text-disabled)' }}>
                        {t('dbInfo.noDbMatch')}
                      </td>
                    </tr>
                  ) : (
                    visibleDatabases.map((d) => {
                      const size = d.total_size_bytes ?? 0;
                      const pct = serverSummary.size > 0 ? (size / serverSummary.size) * 100 : 0;
                      const isSwitching = switchingDb === d.db_name;

                      return (
                        <tr
                          key={d.schema_name || d.db_name}
                          className={d.is_current ? 'stat-row is-current' : 'stat-row'}
                        >
                          <td style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <span
                                title={d.db_name}
                                style={{ fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: d.is_system ? 'var(--win-text-secondary)' : 'var(--win-accent)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              >
                                {d.db_name}
                              </span>
                              {d.is_current && (
                                <span style={{ fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'var(--win-status-added)', color: 'var(--win-status-added-border)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  {t('dbInfo.inUse')}
                                </span>
                              )}
                              {d.is_system && (
                                <span title={t('dbInfo.systemDbTitle')} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '4px', background: 'var(--win-bg-tab-bar)', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                  <Lock size={9} /> {t('dbInfo.system')}
                                </span>
                              )}
                              {d.error && (
                                <span title={d.error} style={{ fontSize: '10px', color: 'var(--st-danger, #ef4444)' }}>⚠</span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <div style={{ flex: 1, minWidth: '80px', height: '6px', borderRadius: '3px', background: 'var(--win-bg-tab-bar)', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: '3px', background: d.is_system ? 'var(--win-text-disabled)' : 'var(--win-accent)' }} />
                              </div>
                              <span style={{ fontFamily: 'var(--win-font-mono, monospace)', fontSize: '11px', color: 'var(--win-text-secondary)', width: '46px', textAlign: 'right', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                {metricCell(d.total_size_bytes, () => `${pct.toFixed(1)}%`)}
                              </span>
                            </div>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', fontWeight: 600, color: 'var(--win-text-primary)', whiteSpace: 'nowrap' }}>
                            {metricCell(d.total_size_bytes, formatBytes)}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>
                            {metricCell(d.total_tables, (n) => n.toLocaleString())}
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontFamily: 'var(--win-font-mono, monospace)', color: 'var(--win-text-secondary)', whiteSpace: 'nowrap' }}>
                            {metricCell(
                              d.total_rows,
                              (n) => `${allStats?.rows_are_exact ? '' : '~'}${n.toLocaleString()}`
                            )}
                          </td>
                          <td style={{ padding: '10px 16px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            <span title={d.collation || undefined} style={{ padding: '2px 8px', fontSize: '11px', fontWeight: 500, background: 'var(--win-bg-tab-bar)', borderRadius: '4px', border: '1px solid var(--win-border)', color: 'var(--win-text-secondary)' }}>
                              {d.charset || '-'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 16px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                            {allStats?.db_type === 'sqlite' || d.is_current ? (
                              <span style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>—</span>
                            ) : (
                              <button
                                onClick={() => handleSwitchDatabase(d.db_name)}
                                disabled={isSwitching || switchingDb !== null}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '5px',
                                  fontSize: '11px',
                                  fontWeight: 500,
                                  color: '#ffffff',
                                  background: 'var(--win-accent)',
                                  border: 'none',
                                  padding: '5px 12px',
                                  borderRadius: '4px',
                                  cursor: switchingDb !== null ? 'default' : 'pointer',
                                  opacity: switchingDb !== null && !isSwitching ? 0.5 : 1,
                                  whiteSpace: 'nowrap',
                                  flexShrink: 0,
                                }}
                              >
                                <span>{isSwitching ? t('dbInfo.switching') : t('dbInfo.switchDb')}</span>
                                {!isSwitching && <ExternalLink size={12} />}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
          </>)}
        </div>

        {/* Modal Footer */}
        <ModalFooter style={{ justifyContent: 'space-between', fontSize: '12px', color: 'var(--win-text-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--win-status-added-border, #10b981)' }} />
            <span>{t('dbInfo.catalogNote')}</span>
          </div>
          <button className="btn btn-secondary" onClick={onClose} style={{ padding: '0 20px' }}>
            {t('common.close')}
          </button>
        </ModalFooter>
    </Modal>
  );
};
