import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  Columns3,
  Copy,
  Database,
  Download,
  FileCode,
  GitCompare,
  Hash,
  Loader,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import {
  columnChangeKey,
  describeColumn,
  describeForeignKey,
  describeIndex,
  filterTableDiffs,
  formatCell,
  hasRunnableSql,
  joinSyncSql,
  statusLabelKey,
  statusTone,
  syncSqlFileName,
  totalDiffCount,
  type ColumnMeta,
  type CompareSide,
  type DataCompareResult,
  type DataOverviewResult,
  type DiffStatus,
  type ForeignKeyMeta,
  type IndexMeta,
  type ItemDiff,
  type SchemaCompareResult,
  type TableDiff,
} from '../utils/compareHelper';
import { Modal, ModalBody } from './Modal';

interface DbCompareDialogProps {
  /** `sqlite` | `postgres` | `mysql` — quyết định phía nào chọn tệp, phía nào chọn database. */
  dbType: string;
  /** Database đang mở, dùng làm mặc định cho phía nguồn. */
  currentDb?: string;
  onClose: () => void;
  /** Mở script đồng bộ trong một tab SQL Editor mới. */
  onOpenInSqlEditor?: (sql: string) => void;
}

const TONE_COLOR: Record<string, string> = {
  ok: 'var(--st-ok)',
  warn: 'var(--st-warn)',
  danger: 'var(--st-danger)',
  muted: 'var(--win-text-secondary)',
};

const label: React.CSSProperties = { fontSize: '11px', fontWeight: 600, color: 'var(--win-text-secondary)' };
const input: React.CSSProperties = {
  background: 'var(--win-bg-window)',
  border: '1px solid var(--win-border)',
  color: 'var(--win-text-primary)',
  borderRadius: '4px',
  padding: '5px 7px',
  fontSize: '11.5px',
  outline: 'none',
  width: '100%',
};
const mono: React.CSSProperties = { fontFamily: 'var(--win-font-mono)', fontSize: '11px' };

const Badge: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <span
    style={{
      fontSize: '10px',
      fontWeight: 600,
      color: TONE_COLOR[tone],
      border: `1px solid ${TONE_COLOR[tone]}`,
      borderRadius: '3px',
      padding: '1px 5px',
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const Chip: React.FC<{ tone?: string; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <span
    style={{
      fontSize: '11px',
      color: TONE_COLOR[tone],
      background: 'var(--win-bg-window)',
      border: '1px solid var(--win-border)',
      borderRadius: '4px',
      padding: '2px 7px',
    }}
  >
    {children}
  </span>
);

export const DbCompareDialog: React.FC<DbCompareDialogProps> = ({
  dbType,
  currentDb,
  onClose,
  onOpenInSqlEditor,
}) => {
  const { t, i18n } = useTranslation();
  const isSqlite = dbType === 'sqlite';
  const isPostgres = dbType === 'postgres';

  const [mode, setMode] = useState<'structure' | 'data'>('structure');
  const [source, setSource] = useState<CompareSide>({ database: currentDb || '', schema: isPostgres ? 'public' : '' });
  const [target, setTarget] = useState<CompareSide>({ database: '', schema: isPostgres ? 'public' : '' });
  const [databases, setDatabases] = useState<string[]>([]);
  const [includeDrops, setIncludeDrops] = useState(false);

  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const [schemaResult, setSchemaResult] = useState<SchemaCompareResult | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Set<DiffStatus>>(new Set());
  const [rightTab, setRightTab] = useState<'diff' | 'sql'>('diff');

  const [overview, setOverview] = useState<DataOverviewResult | null>(null);
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [keyText, setKeyText] = useState('');
  const [rowLimit, setRowLimit] = useState(20000);
  const [dataResult, setDataResult] = useState<DataCompareResult | null>(null);
  const [dataTab, setDataTab] = useState<'rows' | 'sql'>('rows');

  // Danh sách database của server để chọn hai phía (SQLite thì mỗi phía là một tệp).
  useEffect(() => {
    if (isSqlite) return;
    let alive = true;
    dbHelper.listDatabases().then((res) => {
      if (alive && res.success) setDatabases(res.databases);
    });
    return () => {
      alive = false;
    };
  }, [isSqlite]);

  const sideReady = isSqlite
    ? !!source.filePath?.trim() && !!target.filePath?.trim()
    : !!target.database?.trim();

  const swap = () => {
    setSource(target);
    setTarget(source);
    setSchemaResult(null);
    setOverview(null);
    setDataResult(null);
    setSelectedTable(null);
    setDataTable(null);
  };

  const runSchemaCompare = useCallback(async () => {
    setError(null);
    setNotice('');
    setBusy(t('compare.busySchema'));
    try {
      const res = await dbHelper.compareSchemas(source, target, includeDrops);
      setSchemaResult(res);
      setSelectedTable(res.tables.find((x) => x.status !== 'identical')?.name ?? res.tables[0]?.name ?? null);
      setRightTab('diff');
    } catch (err: any) {
      setSchemaResult(null);
      setError(t('compare.errRun', { message: String(err) }));
    } finally {
      setBusy('');
    }
  }, [source, target, includeDrops, t]);

  const runOverview = useCallback(async () => {
    setError(null);
    setNotice('');
    setBusy(t('compare.busyOverview'));
    try {
      const res = await dbHelper.compareDataOverview(source, target);
      setOverview(res);
      setDataTable(null);
      setDataResult(null);
    } catch (err: any) {
      setOverview(null);
      setError(t('compare.errRun', { message: String(err) }));
    } finally {
      setBusy('');
    }
  }, [source, target, t]);

  const runDataCompare = useCallback(
    async (table: string, keys: string[]) => {
      setError(null);
      setNotice('');
      setBusy(t('compare.busyData', { name: table }));
      try {
        const res = await dbHelper.compareTableData(source, target, table, {
          keyColumns: keys.length ? keys : undefined,
          limit: rowLimit,
          includeDrops,
        });
        setDataResult(res);
        setKeyText(res.keyColumns.join(', '));
        setDataTab('rows');
      } catch (err: any) {
        setDataResult(null);
        setError(t('compare.errRun', { message: String(err) }));
      } finally {
        setBusy('');
      }
    },
    [source, target, rowLimit, includeDrops, t],
  );

  const openTableData = (table: string, pk: string[]) => {
    setDataTable(table);
    setKeyText(pk.join(', '));
    setDataResult(null);
    void runDataCompare(table, pk);
  };

  const currentSql = mode === 'structure' ? schemaResult?.syncSql : dataResult?.syncSql;
  const sqlText = useMemo(() => (currentSql ? joinSyncSql(currentSql) : ''), [currentSql]);

  const copySql = async () => {
    await navigator.clipboard.writeText(sqlText);
    setNotice(t('compare.copied'));
  };

  const downloadSql = () => {
    const name = syncSqlFileName(mode === 'structure' ? 'schema' : 'data', target.database || target.filePath || '');
    const blob = new Blob([sqlText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const filtered = useMemo(
    () => (schemaResult ? filterTableDiffs(schemaResult.tables, { statuses: statusFilter, search }) : []),
    [schemaResult, statusFilter, search],
  );
  const selected = filtered.find((x) => x.name === selectedTable) ?? schemaResult?.tables.find((x) => x.name === selectedTable) ?? null;

  // Số bảng theo từng trạng thái: nút lọc nào không có bảng thì hiện (0) và bị khoá,
  // để không ai bấm vào rồi tưởng nút hỏng khi danh sách trống.
  const statusCounts = useMemo(() => {
    const counts: Record<DiffStatus, number> = { onlySource: 0, onlyTarget: 0, different: 0, identical: 0 };
    schemaResult?.tables.forEach((tb) => {
      counts[tb.status] += 1;
    });
    return counts;
  }, [schemaResult]);

  const toggleStatus = (s: DiffStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString(i18n.language));

  // ---- Chọn phía ----
  const sideCard = (which: 'source' | 'target') => {
    const value = which === 'source' ? source : target;
    const setValue = which === 'source' ? setSource : setTarget;
    const patch = (p: Partial<CompareSide>) => {
      setValue({ ...value, ...p });
      setSchemaResult(null);
      setOverview(null);
      setDataResult(null);
    };
    return (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          border: '1px solid var(--win-border)',
          borderRadius: '6px',
          padding: '8px 10px',
          background: 'var(--win-bg-window)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '5px' }}>
          <Database size={12} />
          {which === 'source' ? t('compare.sourceLabel') : t('compare.targetLabel')}
        </div>
        {isSqlite ? (
          <input
            type="text"
            style={input}
            value={value.filePath || ''}
            placeholder={t('compare.sqlitePathPlaceholder')}
            onChange={(e) => patch({ filePath: e.target.value })}
          />
        ) : (
          <>
            <select style={input} value={value.database || ''} onChange={(e) => patch({ database: e.target.value })}>
              <option value="">{t('compare.currentDatabase')}</option>
              {databases.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            {isPostgres && (
              <input
                type="text"
                style={input}
                value={value.schema || ''}
                placeholder={t('compare.schemaPlaceholder')}
                onChange={(e) => patch({ schema: e.target.value })}
              />
            )}
          </>
        )}
      </div>
    );
  };

  // ---- Bảng chi tiết của một mục (cột / index / FK) ----
  const detailRows = <T,>(
    items: ItemDiff<T>[],
    describe: (v: T | null) => string,
    title: string,
    icon: React.ReactNode,
  ) => {
    const shown = items.filter((i) => i.status !== 'identical');
    if (shown.length === 0) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '5px' }}>
          {icon}
          {title} ({shown.length})
        </div>
        <div style={{ border: '1px solid var(--win-border)', borderRadius: '4px', overflow: 'hidden' }}>
          {shown.map((it) => (
            <div
              key={it.name}
              style={{
                display: 'grid',
                gridTemplateColumns: '160px 1fr 1fr',
                gap: '8px',
                padding: '5px 8px',
                borderBottom: '1px solid var(--win-border)',
                alignItems: 'start',
                fontSize: '11px',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{it.name}</span>
                <Badge tone={statusTone(it.status)}>{t(statusLabelKey(it.status) as never)}</Badge>
                {it.changes.length > 0 && (
                  <span style={{ color: 'var(--win-text-disabled)', fontSize: '10px' }}>
                    {it.changes.map((c) => t(columnChangeKey(c) as never)).join(', ')}
                  </span>
                )}
              </div>
              <div style={{ ...mono, color: it.source ? 'var(--win-text-primary)' : 'var(--win-text-disabled)', wordBreak: 'break-word' }}>
                {describe(it.source)}
              </div>
              <div style={{ ...mono, color: it.target ? 'var(--win-text-primary)' : 'var(--win-text-disabled)', wordBreak: 'break-word' }}>
                {describe(it.target)}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const sqlPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={label}>{t('compare.syncSqlTitle')}</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button className="btn btn-secondary" onClick={copySql} disabled={!sqlText} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Copy size={11} /> {t('compare.copySql')}
          </button>
          <button className="btn btn-secondary" onClick={downloadSql} disabled={!sqlText} style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Download size={11} /> {t('compare.downloadSql')}
          </button>
          {onOpenInSqlEditor && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                onOpenInSqlEditor(sqlText);
                onClose();
              }}
              disabled={!sqlText || !hasRunnableSql(currentSql || [])}
              title={t('compare.openInEditorTitle')}
              style={{ padding: '0 10px', display: 'flex', alignItems: 'center', gap: '4px' }}
            >
              <FileCode size={11} /> {t('compare.openInEditor')}
            </button>
          )}
        </div>
      </div>
      <textarea
        readOnly
        value={sqlText || t('compare.sqlEmpty')}
        style={{
          flex: 1,
          minHeight: '120px',
          width: '100%',
          background: 'var(--win-bg-window)',
          border: '1px solid var(--win-border)',
          color: 'var(--win-text-primary)',
          fontFamily: 'var(--win-font-mono)',
          fontSize: '11px',
          padding: '10px',
          borderRadius: '4px',
          resize: 'none',
          outline: 'none',
        }}
      />
    </div>
  );

  // ---- Tab CẤU TRÚC ----
  const structurePane = (
    <>
      {schemaResult && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          <Chip tone="ok">{t('compare.summaryOnlySource', { n: schemaResult.summary.tablesOnlySource })}</Chip>
          <Chip tone="danger">{t('compare.summaryOnlyTarget', { n: schemaResult.summary.tablesOnlyTarget })}</Chip>
          <Chip tone="warn">{t('compare.summaryDifferent', { n: schemaResult.summary.tablesDifferent })}</Chip>
          <Chip>{t('compare.summaryIdentical', { n: schemaResult.summary.tablesIdentical })}</Chip>
          <Chip>
            {t('compare.summaryColumns', {
              a: schemaResult.summary.columnsOnlySource,
              b: schemaResult.summary.columnsOnlyTarget,
              c: schemaResult.summary.columnsDifferent,
            })}
          </Chip>
          <Chip>{t('compare.summaryIndexes', { n: schemaResult.summary.indexDiffs })}</Chip>
          <Chip>{t('compare.summaryForeignKeys', { n: schemaResult.summary.foreignKeyDiffs })}</Chip>
          <span style={{ marginLeft: 'auto', ...label }}>
            {t('compare.totalDiff', { n: totalDiffCount(schemaResult.summary) })}
          </span>
        </div>
      )}

      {schemaResult && schemaResult.identical && (
        <div style={{ fontSize: '12px', color: 'var(--st-ok)' }}>{t('compare.identicalSchema')}</div>
      )}

      {!schemaResult && !busy && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px', textAlign: 'center', padding: '0 32px' }}>
          {t('compare.emptyHintStructure')}
        </div>
      )}

      {schemaResult && (
        <div style={{ display: 'flex', flex: 1, gap: '10px', minHeight: 0 }}>
          {/* Danh sách bảng */}
          <div style={{ width: '260px', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: 0 }}>
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                style={{ ...input, paddingRight: '24px' }}
                placeholder={t('compare.searchTables')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Search size={11} style={{ position: 'absolute', right: '7px', top: '50%', transform: 'translateY(-50%)', color: 'var(--win-text-secondary)', pointerEvents: 'none' }} />
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
              {(['onlySource', 'onlyTarget', 'different', 'identical'] as DiffStatus[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  disabled={statusCounts[s] === 0}
                  title={statusCounts[s] === 0 ? t('compare.filterEmpty') : undefined}
                  className={`btn ${statusFilter.has(s) ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0 7px', height: '22px', fontSize: '10px' }}
                >
                  {t(statusLabelKey(s) as never)} ({statusCounts[s]})
                </button>
              ))}
              {statusFilter.size > 0 && (
                <button
                  type="button"
                  onClick={() => setStatusFilter(new Set())}
                  className="btn btn-secondary"
                  style={{ padding: '0 7px', height: '22px', fontSize: '10px' }}
                >
                  {t('compare.clearFilter')}
                </button>
              )}
            </div>
            <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--win-border)', borderRadius: '4px' }}>
              {filtered.length === 0 && (
                <div style={{ padding: '8px', fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('compare.noTableMatch')}</div>
              )}
              {filtered.map((tb: TableDiff) => (
                <div
                  key={tb.name}
                  onClick={() => setSelectedTable(tb.name)}
                  style={{
                    padding: '5px 8px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--win-border)',
                    background: selectedTable === tb.name ? 'rgba(0,102,204,0.10)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span style={{ fontSize: '11.5px', color: 'var(--win-text-primary)', wordBreak: 'break-all', flex: 1 }}>
                    {tb.name}
                    {tb.kind === 'view' && (
                      <span style={{ color: 'var(--win-text-disabled)', fontSize: '10px' }}> · {t('compare.kindView')}</span>
                    )}
                  </span>
                  <Badge tone={statusTone(tb.status)}>{tb.status === 'identical' ? '=' : tb.diffCount}</Badge>
                </div>
              ))}
            </div>
          </div>

          {/* Chi tiết / SQL */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0, minHeight: 0 }}>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className={`btn ${rightTab === 'diff' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRightTab('diff')} style={{ padding: '0 10px' }}>
                {t('compare.tabDetail')}
              </button>
              <button className={`btn ${rightTab === 'sql' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRightTab('sql')} style={{ padding: '0 10px' }}>
                {t('compare.tabSyncSql')}
              </button>
            </div>

            {rightTab === 'sql' ? (
              sqlPane
            ) : !selected ? (
              <div style={{ color: 'var(--win-text-disabled)', fontSize: '12px' }}>{t('compare.pickTable')}</div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{selected.name}</span>
                  <Badge tone={statusTone(selected.status)}>{t(statusLabelKey(selected.status) as never)}</Badge>
                  {selected.changes.map((c) => (
                    <Chip key={c}>{t(columnChangeKey(c) as never)}</Chip>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: '8px', ...label }}>
                  <span>{t('compare.headerItem')}</span>
                  <span>{t('compare.headerSource')}</span>
                  <span>{t('compare.headerTarget')}</span>
                </div>
                {detailRows<ColumnMeta>(selected.columns, describeColumn, t('compare.sectionColumns'), <Columns3 size={12} />)}
                {detailRows<IndexMeta>(selected.indexes, describeIndex, t('compare.sectionIndexes'), <Hash size={12} />)}
                {detailRows<ForeignKeyMeta>(selected.foreignKeys, describeForeignKey, t('compare.sectionForeignKeys'), <GitCompare size={12} />)}
                {selected.primaryKey.differs && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={label}>{t('compare.sectionPrimaryKey')}</span>
                    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: '8px', fontSize: '11px', padding: '5px 8px', border: '1px solid var(--win-border)', borderRadius: '4px' }}>
                      <Badge tone="warn">{t('compare.statusDifferent')}</Badge>
                      <span style={mono}>{selected.primaryKey.source?.join(', ') || '—'}</span>
                      <span style={mono}>{selected.primaryKey.target?.join(', ') || '—'}</span>
                    </div>
                  </div>
                )}
                {selected.viewDefinitionDiffers && (
                  <div style={{ fontSize: '11px', color: 'var(--st-warn)' }}>{t('compare.viewDefinitionDiffers')}</div>
                )}
                {selected.status === 'identical' && (
                  <div style={{ fontSize: '11.5px', color: 'var(--st-ok)' }}>{t('compare.identicalTable')}</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );

  // ---- Tab DỮ LIỆU ----
  const dataPane = (
    <>
      {!overview && !busy && !dataResult && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--win-text-disabled)', fontSize: '12px', textAlign: 'center', padding: '0 32px' }}>
          {t('compare.emptyHintData')}
        </div>
      )}

      {overview && !dataTable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minHeight: 0 }}>
          <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{t('compare.overviewHeader', { n: overview.tables.length })}</span>
            <Chip tone="warn">{t('compare.overviewDiffTables', { n: overview.tablesWithDifference })}</Chip>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--win-border)', borderRadius: '4px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px 130px 110px', gap: '8px', padding: '5px 8px', borderBottom: '1px solid var(--win-border)', position: 'sticky', top: 0, background: 'var(--win-bg-card)', ...label }}>
              <span>{t('compare.colTable')}</span>
              <span style={{ textAlign: 'right' }}>{t('compare.colRowsSource')}</span>
              <span style={{ textAlign: 'right' }}>{t('compare.colRowsTarget')}</span>
              <span>{t('compare.colStatus')}</span>
              <span />
            </div>
            {overview.tables.map((row) => (
              <div
                key={row.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 110px 110px 130px 110px',
                  gap: '8px',
                  padding: '4px 8px',
                  borderBottom: '1px solid var(--win-border)',
                  alignItems: 'center',
                  fontSize: '11.5px',
                }}
              >
                <span style={{ color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>{row.name}</span>
                <span style={{ ...mono, textAlign: 'right' }}>{num(row.sourceRows)}</span>
                <span style={{ ...mono, textAlign: 'right' }}>{num(row.targetRows)}</span>
                <span>
                  <Badge tone={statusTone(row.status)}>{t(statusLabelKey(row.status) as never)}</Badge>
                </span>
                <span>
                  {row.status !== 'onlySource' && row.status !== 'onlyTarget' && (
                    <button
                      className="btn btn-secondary"
                      style={{ padding: '0 8px', height: '22px', fontSize: '10px' }}
                      title={row.comparable ? undefined : t('compare.noKeyHint')}
                      onClick={() => openTableData(row.name, row.primaryKey)}
                    >
                      {t('compare.compareThisTable')}
                    </button>
                  )}
                </span>
              </div>
            ))}
            {overview.tables.some((r) => r.error) && (
              <div style={{ padding: '6px 8px', fontSize: '11px', color: 'var(--st-warn)' }}>
                {t('compare.overviewSomeErrors')}
              </div>
            )}
          </div>
        </div>
      )}

      {dataTable && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => { setDataTable(null); setDataResult(null); }} style={{ padding: '0 9px', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <ArrowLeft size={12} /> {t('compare.backToOverview')}
            </button>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', flex: 1, minWidth: '180px' }}>
              <span style={label}>{t('compare.keyColumnsLabel', { name: dataTable })}</span>
              <input type="text" style={input} value={keyText} placeholder={t('compare.keyColumnsPlaceholder')} onChange={(e) => setKeyText(e.target.value)} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', width: '130px' }}>
              <span style={label}>{t('compare.limitLabel')}</span>
              <input
                type="number"
                min={1}
                style={input}
                value={rowLimit}
                onChange={(e) => setRowLimit(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <button
              className="btn btn-primary"
              disabled={!!busy}
              onClick={() => runDataCompare(dataTable, keyText.split(',').map((s) => s.trim()).filter(Boolean))}
              style={{ padding: '0 12px', display: 'flex', alignItems: 'center', gap: '5px' }}
            >
              <RefreshCw size={12} className={busy ? 'loading-spinner' : undefined} /> {t('compare.runData')}
            </button>
          </div>

          {dataResult && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                <Chip tone="ok">{t('compare.summaryRowsOnlySource', { n: dataResult.summary.onlySource })}</Chip>
                <Chip tone="danger">{t('compare.summaryRowsOnlyTarget', { n: dataResult.summary.onlyTarget })}</Chip>
                <Chip tone="warn">{t('compare.summaryRowsDifferent', { n: dataResult.summary.different })}</Chip>
                <Chip>{t('compare.summaryRowsIdentical', { n: dataResult.summary.identical })}</Chip>
                <Chip>{t('compare.summaryRowsScanned', { a: dataResult.summary.sourceRows, b: dataResult.summary.targetRows })}</Chip>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                  <button className={`btn ${dataTab === 'rows' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDataTab('rows')} style={{ padding: '0 10px' }}>
                    {t('compare.tabRows')}
                  </button>
                  <button className={`btn ${dataTab === 'sql' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDataTab('sql')} style={{ padding: '0 10px' }}>
                    {t('compare.tabSyncSql')}
                  </button>
                </span>
              </div>

              {dataResult.identical && <div style={{ fontSize: '12px', color: 'var(--st-ok)' }}>{t('compare.identicalData')}</div>}

              {dataTab === 'sql' ? (
                sqlPane
              ) : (
                <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--win-border)', borderRadius: '4px' }}>
                  {dataResult.rowsTruncated && (
                    <div style={{ padding: '5px 8px', fontSize: '11px', color: 'var(--st-warn)', borderBottom: '1px solid var(--win-border)' }}>
                      {t('compare.rowsTruncated', { n: dataResult.rows.length })}
                    </div>
                  )}
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={thStyle}>{t('compare.colStatus')}</th>
                        <th style={thStyle}>{t('compare.colKey')}</th>
                        <th style={thStyle}>{t('compare.colSide')}</th>
                        {dataResult.columns.map((c) => (
                          <th key={c} style={thStyle}>
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataResult.rows.map((row, ri) => {
                        const cells = (which: 'source' | 'target') => {
                          const data = which === 'source' ? row.source : row.target;
                          return (
                            <tr key={`${ri}-${which}`}>
                              {which === 'source' && (
                                <>
                                  <td style={tdStyle} rowSpan={row.status === 'different' ? 2 : 1}>
                                    <Badge tone={statusTone(row.status)}>{t(statusLabelKey(row.status) as never)}</Badge>
                                  </td>
                                  <td style={{ ...tdStyle, ...mono }} rowSpan={row.status === 'different' ? 2 : 1}>
                                    {row.key.map((k) => formatCell(k)).join(' / ')}
                                  </td>
                                </>
                              )}
                              {which === 'target' && row.status !== 'different' && (
                                <>
                                  <td style={tdStyle}>
                                    <Badge tone={statusTone(row.status)}>{t(statusLabelKey(row.status) as never)}</Badge>
                                  </td>
                                  <td style={{ ...tdStyle, ...mono }}>{row.key.map((k) => formatCell(k)).join(' / ')}</td>
                                </>
                              )}
                              <td style={{ ...tdStyle, fontWeight: 600 }}>
                                {which === 'source' ? t('compare.sideA') : t('compare.sideB')}
                              </td>
                              {dataResult.columns.map((c) => (
                                <td
                                  key={c}
                                  style={{
                                    ...tdStyle,
                                    ...mono,
                                    background: row.changedColumns.includes(c) ? 'rgba(255,159,10,0.12)' : undefined,
                                    color: data ? 'var(--win-text-primary)' : 'var(--win-text-disabled)',
                                  }}
                                >
                                  {data ? formatCell(data[c]) : '—'}
                                </td>
                              ))}
                            </tr>
                          );
                        };
                        if (row.status === 'onlySource') return cells('source');
                        if (row.status === 'onlyTarget') return cells('target');
                        return (
                          <React.Fragment key={ri}>
                            {cells('source')}
                            {cells('target')}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );

  const warnings = (mode === 'structure' ? schemaResult?.warnings : dataResult?.warnings) || [];

  return (
    <Modal
      title={t('compare.title')}
      icon={<ArrowLeftRight size={14} style={{ color: 'var(--win-accent)', flexShrink: 0 }} />}
      onClose={onClose}
      width="1180px"
      maxWidth="96vw"
      height="88vh"
      zIndex={10000}
    >
        <ModalBody style={{ padding: '12px 16px', gap: '10px', flex: 1 }}>
          {/* Hai phía */}
          <div style={{ display: 'flex', alignItems: 'stretch', gap: '8px' }}>
            {sideCard('source')}
            <button
              className="btn btn-secondary"
              title={t('compare.swapSides')}
              onClick={swap}
              style={{ alignSelf: 'center', width: '30px', height: '28px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <ArrowLeftRight size={13} />
            </button>
            {sideCard('target')}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--win-text-disabled)' }}>{t('compare.directionHint')}</div>

          {/* Chế độ + hành động */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button className={`btn ${mode === 'structure' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('structure')} style={{ padding: '0 12px' }}>
              {t('compare.tabStructure')}
            </button>
            <button className={`btn ${mode === 'data' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('data')} style={{ padding: '0 12px' }}>
              {t('compare.tabData')}
            </button>

            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--win-text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={includeDrops} onChange={(e) => setIncludeDrops(e.target.checked)} />
              {t('compare.includeDrops')}
            </label>

            <button
              className="btn btn-primary"
              disabled={!!busy || !sideReady}
              onClick={() => (mode === 'structure' ? runSchemaCompare() : runOverview())}
              title={sideReady ? undefined : t('compare.pickSidesFirst')}
              style={{ marginLeft: 'auto', padding: '0 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {busy ? <Loader size={12} className="loading-spinner" /> : <Play size={12} />}
              {mode === 'structure' ? t('compare.runStructure') : t('compare.runOverview')}
            </button>
          </div>

          {busy && (
            <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Loader size={12} className="loading-spinner" />
              {busy}
            </div>
          )}
          {notice && !busy && <div style={{ fontSize: '11px', color: 'var(--st-ok)' }}>{notice}</div>}
          {error && (
            <div style={{ fontSize: '11px', color: 'var(--st-danger)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '4px', padding: '6px 8px' }}>
              {error}
            </div>
          )}
          {warnings.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--st-warn)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {warnings.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <AlertTriangle size={11} /> {w}
                </div>
              ))}
            </div>
          )}

          {mode === 'structure' ? structurePane : dataPane}
        </ModalBody>
    </Modal>
  );
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontSize: '10.5px',
  fontWeight: 600,
  color: 'var(--win-text-secondary)',
  padding: '4px 7px',
  borderBottom: '1px solid var(--win-border)',
  borderRight: '1px solid var(--win-border)',
  position: 'sticky',
  top: 0,
  background: 'var(--win-bg-card)',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  fontSize: '11px',
  padding: '3px 7px',
  borderBottom: '1px solid var(--win-border)',
  borderRight: '1px solid var(--win-border)',
  maxWidth: '240px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'top',
};
