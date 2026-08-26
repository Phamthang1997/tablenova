import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Database, Dice5, Loader, RefreshCw, Search, Table2, Wand2 } from 'lucide-react';
import { dbHelper } from '../utils/dbHelper';
import {
  GENERATOR_GROUPS,
  estimateRemainingMs,
  formatCount,
  formatDuration,
  formatListInput,
  generatorLabelKey,
  hasBlockingIssue,
  isTextGenerator,
  optionChoiceLabelKey,
  optionFields,
  parseListInput,
  tableSpecFromTarget,
  totalRowsOf,
  validateSpec,
  type GenColumnSpec,
  type GenColumnTarget,
  type GenPreview,
  type GenProgress,
  type GenResult,
  type GenSpec,
  type GenTableSpec,
  type GenTableTarget,
  type GenTargets,
  type OptionField,
} from '../utils/dataGenHelper';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { ProgressBar } from './ProgressBar';
import { cancelJob, startJob } from '../utils/jobs';

interface DataGeneratorDialogProps {
  /** The target connection. Explicit, because a generation run happens as a background job — see dbHelper.generateData. */
  connId: string;
  /** Server + database the data will be written to — shown in the footer, since this writes. */
  dbName?: string;
  /** Preselect one table (opened from the table context menu). */
  initialTable?: string | null;
  onClose: () => void;
}

/** Seed used on open. Random only in the sense of "pick one" — generation itself stays exact. */
const rollSeed = () => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % 2_000_000_000;
  }
  return Date.now() % 2_000_000_000;
};

const Badge: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span className="dgen-badge" title={title}>
    {children}
  </span>
);

/** One labelled control. */
const Field: React.FC<{ text: string; children: React.ReactNode }> = ({ text, children }) => (
  <div className="dgen-field">
    <span className="dgen-label">{text}</span>
    {children}
  </div>
);

export const DataGeneratorDialog: React.FC<DataGeneratorDialogProps> = ({ connId, dbName, initialTable, onClose }) => {
  const { t, i18n } = useTranslation();

  const [targets, setTargets] = useState<GenTargets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  /**
   * The seed is not a headline setting — it only matters when someone wants the exact same data
   * again — so it lives as a chip next to the preview instead of taking a slot in the top bar.
   */
  const [seed, setSeed] = useState(rollSeed);
  const [defaultRows, setDefaultRows] = useState(1000);
  const [disableConstraints, setDisableConstraints] = useState(true);

  /** Per-table spec, only for the tables the user ticked. */
  const [specs, setSpecs] = useState<Record<string, GenTableSpec>>({});
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  const [preview, setPreview] = useState<GenPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** Bumped by the refresh button. Re-rolling the same seed would be a no-op re-render. */
  const [previewNonce, setPreviewNonce] = useState(0);

  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenProgress | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const startedAtRef = useRef(0);
  /** The current run's job — the footer's Cancel button aims at it. */
  const jobIdRef = useRef<string | null>(null);

  // ---- load targets ----
  useEffect(() => {
    let alive = true;
    dbHelper
      .getGenerationTargets()
      .then((res) => {
        if (!alive) return;
        setTargets(res);
        const preselect = initialTable && res.tables.some((x) => x.table === initialTable) ? initialTable : null;
        const target = preselect ? res.tables.find((x) => x.table === preselect) : undefined;
        if (target) {
          setSpecs({ [target.table]: tableSpecFromTarget(target, 1000) });
          setActiveTable(target.table);
        }
      })
      .catch((err) => {
        if (alive) setLoadError(String(err));
      });
    return () => {
      alive = false;
    };
  }, [initialTable]);

  const tableTargets = useMemo(() => targets?.tables ?? [], [targets]);
  const activeTarget: GenTableTarget | undefined = tableTargets.find((x) => x.table === activeTable);
  const activeSpec: GenTableSpec | undefined = activeTable ? specs[activeTable] : undefined;
  const activeColSpec: GenColumnSpec | undefined = activeSpec?.columns.find((c) => c.column === activeColumn);
  const activeColTarget: GenColumnTarget | undefined = activeTarget?.columns.find((c) => c.name === activeColumn);

  const spec: GenSpec = useMemo(
    () => ({
      seed,
      // Keep the backend's FK-safe order; it also decides which parent is generated first.
      tables: (targets?.order ?? []).map((name) => specs[name]).filter(Boolean) as GenTableSpec[],
      options: { disableConstraints },
    }),
    [seed, specs, targets?.order, disableConstraints],
  );

  const issues = useMemo(() => validateSpec(spec), [spec]);
  const blocked = hasBlockingIssue(issues);
  const totalRows = totalRowsOf(spec);

  const filteredTables = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return tableTargets;
    return tableTargets.filter((x) => x.table.toLowerCase().includes(needle));
  }, [tableTargets, search]);

  // ---- table selection ----
  const toggleTable = (target: GenTableTarget) => {
    setSpecs((prev) => {
      const next = { ...prev };
      if (next[target.table]) delete next[target.table];
      else next[target.table] = tableSpecFromTarget(target, defaultRows);
      return next;
    });
    setActiveTable(target.table);
    setActiveColumn(null);
  };

  const selectAll = () => {
    setSpecs(() => {
      const next: Record<string, GenTableSpec> = {};
      for (const target of filteredTables) next[target.table] = tableSpecFromTarget(target, defaultRows);
      return next;
    });
  };

  const clearAll = () => {
    setSpecs({});
    setActiveTable(null);
    setActiveColumn(null);
  };

  const applyRowsToAll = () => {
    setSpecs((prev) => {
      const next: Record<string, GenTableSpec> = {};
      for (const [name, table] of Object.entries(prev)) next[name] = { ...table, rows: defaultRows };
      return next;
    });
  };

  const patchTable = (table: string, patch: Partial<GenTableSpec>) => {
    setSpecs((prev) => (prev[table] ? { ...prev, [table]: { ...prev[table], ...patch } } : prev));
  };

  const patchColumn = (table: string, column: string, patch: Partial<GenColumnSpec>) => {
    setSpecs((prev) => {
      const current = prev[table];
      if (!current) return prev;
      return {
        ...prev,
        [table]: {
          ...current,
          columns: current.columns.map((c) => (c.column === column ? { ...c, ...patch } : c)),
        },
      };
    });
  };

  const patchOption = (table: string, column: string, key: string, value: unknown) => {
    setSpecs((prev) => {
      const current = prev[table];
      if (!current) return prev;
      return {
        ...prev,
        [table]: {
          ...current,
          columns: current.columns.map((c) => {
            if (c.column !== column) return c;
            const options = { ...c.options };
            if (value === '' || value === undefined) delete options[key];
            else options[key] = value;
            return { ...c, options };
          }),
        },
      };
    });
  };

  // ---- preview (debounced, backend-driven so it matches the real run) ----
  // The WHOLE spec is sent, not just the previewed table: a foreign key column needs the parent's
  // spec to show the keys the parent is about to get (see `estimate_fk_pool` in data_generator.rs).
  // Sending one table made every FK preview a column of NULLs.
  const previewKey = activeTable ? `${activeTable}|${JSON.stringify(spec)}` : '';
  useEffect(() => {
    if (!activeTable || !activeSpec || running) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setPreviewBusy(true);
      setPreviewError(null);
      dbHelper
        .previewGeneratedData(spec, activeTable, 50)
        .then((res) => {
          if (alive) setPreview(res);
        })
        .catch((err) => {
          if (!alive) return;
          setPreview(null);
          setPreviewError(String(err));
        })
        .finally(() => {
          if (alive) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // previewKey folds the previewed table + the whole spec (seed and options included) into one
    // dependency, so `spec` itself is not in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, previewNonce, running]);

  // ---- run ----
  /**
   * Generation runs as a **background job** (see utils/jobs.ts): the user closes this dialog and goes
   * off to do something else, and the progress and cancel button are still there in `JobsTray`.
   *
   * The dialog keeps `progress`/`result` of its own so it displays exactly as before **while it is
   * open** — two places reading one run, not two runs. After it closes these `setState` calls become
   * no-ops, and the job is left untouched.
   */
  const run = useCallback(() => {
    setRunning(true);
    setRunError(null);
    setResult(null);
    setProgress(null);
    startedAtRef.current = Date.now();
    const rows = totalRows;
    jobIdRef.current = startJob({
      kind: 'generate',
      title: t('jobs.titleGenerate', { n: dbName ?? '' }),
      db: dbName ?? '',
      write: true,
      lockKey: `${connId}|${dbName ?? ''}`,
      // The cancel flag on the Rust side is keyed by `conn_id`, so it has to aim at the connection actually generating.
      onCancel: () => void dbHelper.cancelDataGeneration(connId),
      run: async (ctx) => {
        try {
          const res = await dbHelper.generateData(spec, (msg) => {
            setProgress(msg);
            ctx.report({
              label: t('dataGen.progress', {
                table: msg.table ?? '',
                done: formatCount(msg.totalDone ?? 0, i18n.language),
                total: formatCount(rows, i18n.language),
              }),
              current: msg.totalDone ?? 0,
              total: rows,
            });
          }, connId);
          setResult(res);
          // The row counts changed -> Sidebar/DataGrid reload, even if the dialog closed long ago.
          // The schema did not, so invalidateCatalog is deliberately NOT called.
          window.dispatchEvent(new CustomEvent('database-restored', { detail: { connId } }));
          const inserted = res.inserted ? Object.values(res.inserted).reduce((a, b) => a + b, 0) : 0;
          return {
            message: res.cancelled
              ? t('dataGen.resultCancelled', { n: formatCount(inserted, i18n.language) })
              : t('dataGen.resultDone', {
                  n: formatCount(inserted, i18n.language),
                  time: formatDuration(res.elapsedMs ?? 0, t as never),
                }),
            warning: res.warnings?.length ? res.warnings.join(' · ') : undefined,
          };
        } catch (err) {
          setRunError(String(err));
          throw err;
        } finally {
          setRunning(false);
        }
      },
    });
  }, [spec, connId, dbName, totalRows, t, i18n.language]);

  const doneRows = progress?.totalDone ?? 0;
  const remainingMs = running ? estimateRemainingMs(doneRows, totalRows, Date.now() - startedAtRef.current) : null;
  const insertedTotal = result?.inserted ? Object.values(result.inserted).reduce((a, b) => a + b, 0) : 0;
  const selectedCount = Object.keys(specs).length;
  const truncating = Object.values(specs).some((x) => x.mode === 'truncate');

  const renderOptionField = (field: OptionField, colSpec: GenColumnSpec, table: string) => {
    const value = colSpec.options?.[field.key];
    const placeholder = field.placeholderKey ? t(field.placeholderKey as never) : undefined;
    const set = (v: unknown) => patchOption(table, colSpec.column, field.key, v);

    switch (field.kind) {
      case 'bool':
        return (
          <label key={field.key} className="dgen-check">
            <input type="checkbox" checked={value !== false} onChange={(e) => set(e.target.checked)} />
            {t(field.labelKey as never)}
          </label>
        );
      case 'select':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <select value={String(value ?? field.choices?.[0] ?? '')} onChange={(e) => set(e.target.value)}>
              {(field.choices ?? []).map((choice) => (
                <option key={choice} value={choice}>
                  {t(optionChoiceLabelKey(choice) as never)}
                </option>
              ))}
            </select>
          </Field>
        );
      case 'list':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <textarea
              placeholder={placeholder}
              value={formatListInput(value as unknown[] | undefined, colSpec.generator === 'weightedList')}
              onChange={(e) => set(parseListInput(e.target.value, colSpec.generator === 'weightedList'))}
            />
          </Field>
        );
      case 'number':
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <input
              type="number"
              value={value === undefined ? '' : String(value)}
              onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </Field>
        );
      default:
        // text / date / sql
        return (
          <Field key={field.key} text={t(field.labelKey as never)}>
            <input
              className={field.kind === 'date' ? undefined : 'dgen-mono'}
              placeholder={placeholder}
              value={String(value ?? '')}
              onChange={(e) => set(e.target.value)}
            />
          </Field>
        );
    }
  };

  return (
    <Modal
      title={dbName ? t('dataGen.titleWithDb', { db: dbName }) : t('dataGen.title')}
      icon={<Wand2 size={14} className="title-bar-logo" />}
      onClose={onClose}
      closeDisabled={running}
      width="1180px"
      height="86vh"
      zIndex={10000}
    >
      <ModalBody style={{ overflowY: 'hidden', gap: 0, flex: 1 }}>
        <div className="dgen">
          {/* ---- shared controls ---- */}
          <div className="dgen-bar">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="dgen-label">{t('dataGen.rowsPerTable')}</span>
              <input
                type="number"
                min={1}
                style={{ width: '90px' }}
                value={defaultRows}
                disabled={running}
                onChange={(e) => setDefaultRows(Math.max(1, Number(e.target.value) || 0))}
              />
              <button className="btn btn-secondary" disabled={running || !selectedCount} onClick={applyRowsToAll}>
                {t('dataGen.applyToAll')}
              </button>
            </div>
            <div className="dgen-bar-sep" />
            <label className="dgen-check" title={t('dataGen.disableConstraintsHint')}>
              <input
                type="checkbox"
                checked={disableConstraints}
                disabled={running}
                onChange={(e) => setDisableConstraints(e.target.checked)}
              />
              {t('dataGen.disableConstraints')}
            </label>
            <div className="dgen-dim" style={{ marginLeft: 'auto', fontSize: '11.5px' }}>
              {t('dataGen.summary', { tables: selectedCount, rows: formatCount(totalRows, i18n.language) })}
            </div>
          </div>

          {loadError && (
            <div className="dgen-msg error">
              <AlertTriangle size={12} /> {loadError}
            </div>
          )}
          {(targets?.warnings ?? []).map((w) => (
            <div key={w} className="dgen-msg warn">
              <AlertTriangle size={12} /> {w}
            </div>
          ))}

          {/* ---- three panes ---- */}
          <div className="dgen-grid">
            {/* tables */}
            <div className="dgen-pane">
              <div className="dgen-pane-title">{t('dataGen.paneTables')}</div>
              <div className="dgen-pane-pad" style={{ minHeight: 0, flex: 1, gap: '6px' }}>
                <div style={{ position: 'relative' }}>
                  {/* The input is 28px tall (matching .btn) -> the icon centres vertically. */}
                  <Search
                    size={12}
                    className="dgen-dim"
                    style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)' }}
                  />
                  <input
                    style={{ paddingLeft: '23px' }}
                    placeholder={t('dataGen.searchTables')}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button className="btn btn-secondary" style={{ flex: 1 }} disabled={running} onClick={selectAll}>
                    {t('dataGen.selectAll')}
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1 }}
                    disabled={running || !selectedCount}
                    onClick={clearAll}
                  >
                    {t('dataGen.clearAll')}
                  </button>
                </div>
                <div style={{ overflow: 'auto', minHeight: 0, flex: 1, margin: '0 -8px' }}>
                  {!targets && !loadError && (
                    <div className="dgen-hint" style={{ padding: '6px 13px' }}>
                      <Loader size={12} className="spin" style={{ verticalAlign: '-2px' }} /> {t('dataGen.loading')}
                    </div>
                  )}
                  {targets && !filteredTables.length && (
                    <div className="dgen-hint" style={{ padding: '6px 13px' }}>
                      {t('dataGen.noTables')}
                    </div>
                  )}
                  {filteredTables.map((target) => {
                    const picked = !!specs[target.table];
                    return (
                      <div
                        key={target.table}
                        className={`dgen-row${activeTable === target.table ? ' on' : ''}`}
                        onClick={() => {
                          setActiveTable(target.table);
                          setActiveColumn(null);
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={picked}
                          disabled={running}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleTable(target)}
                        />
                        <Table2 size={12} className="dgen-dim" style={{ flexShrink: 0 }} />
                        <span className={`dgen-row-name${picked ? '' : ' dgen-dim'}`}>{target.table}</span>
                        {picked && (
                          <span className="dgen-dim" style={{ marginLeft: 'auto', fontSize: '10px' }}>
                            {formatCount(specs[target.table].rows, i18n.language)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="dgen-hint">{t('dataGen.insertOrderHint')}</div>
              </div>
            </div>

            {/* columns of the active table */}
            <div className="dgen-pane">
              <div className="dgen-pane-title">
                {activeTable ? t('dataGen.paneColumnsOf', { table: activeTable }) : t('dataGen.paneColumns')}
              </div>
              {!activeTarget && <div className="dgen-hint" style={{ padding: '10px' }}>{t('dataGen.pickTableHint')}</div>}
              {activeTarget && !activeSpec && (
                <div className="dgen-pane-pad">
                  <span className="dgen-hint">{t('dataGen.tableNotSelected')}</span>
                  <div>
                    <button className="btn btn-primary" disabled={running} onClick={() => toggleTable(activeTarget)}>
                      <Check size={13} /> {t('dataGen.selectThisTable')}
                    </button>
                  </div>
                </div>
              )}
              {activeTarget && activeSpec && (
                <>
                  <div
                    className="dgen-pane-title"
                    style={{ textTransform: 'none', letterSpacing: 0, gap: '12px', alignItems: 'flex-end' }}
                  >
                    <Field text={t('dataGen.rows')}>
                      <input
                        type="number"
                        min={1}
                        style={{ width: '110px' }}
                        value={activeSpec.rows}
                        disabled={running}
                        onChange={(e) => patchTable(activeSpec.table, { rows: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </Field>
                    <Field text={t('dataGen.mode')}>
                      <select
                        style={{ width: '170px' }}
                        value={activeSpec.mode ?? 'append'}
                        disabled={running}
                        onChange={(e) => patchTable(activeSpec.table, { mode: e.target.value as 'append' | 'truncate' })}
                      >
                        <option value="append">{t('dataGen.modeAppend')}</option>
                        <option value="truncate">{t('dataGen.modeTruncate')}</option>
                      </select>
                    </Field>
                  </div>
                  <div className="dgen-pane-body">
                    <table className="dgen-table">
                      <thead>
                        <tr>
                          <th>{t('dataGen.colColumn')}</th>
                          <th>{t('dataGen.colType')}</th>
                          <th>{t('dataGen.colGenerator')}</th>
                          <th style={{ textAlign: 'center' }}>{t('dataGen.colUnique')}</th>
                          <th style={{ textAlign: 'right' }}>{t('dataGen.colNullPercent')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeTarget.columns.map((colTarget) => {
                          const colSpec = activeSpec.columns.find((c) => c.column === colTarget.name);
                          if (!colSpec) return null;
                          return (
                            <tr
                              key={colTarget.name}
                              className={activeColumn === colTarget.name ? 'on' : undefined}
                              onClick={() => setActiveColumn(colTarget.name)}
                            >
                              <td>
                                {colTarget.name}
                                {colTarget.isPrimaryKey && <Badge title={t('dataGen.badgePkTitle')}>PK</Badge>}
                                {colTarget.fk && (
                                  <Badge
                                    title={t('dataGen.badgeFkTitle', {
                                      ref: `${colTarget.fk.refTable}.${colTarget.fk.refColumn}`,
                                    })}
                                  >
                                    FK
                                  </Badge>
                                )}
                                {colTarget.autoIncrement && <Badge title={t('dataGen.badgeAutoIncTitle')}>AI</Badge>}
                                {!colTarget.nullable && <Badge title={t('dataGen.badgeNotNullTitle')}>NN</Badge>}
                              </td>
                              <td className="dgen-mono dgen-dim">{colTarget.type}</td>
                              <td>
                                <select
                                  style={{ minWidth: '152px' }}
                                  value={colSpec.generator}
                                  disabled={running}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => {
                                    patchColumn(activeSpec.table, colTarget.name, {
                                      generator: e.target.value,
                                      options: {},
                                    });
                                    setActiveColumn(colTarget.name);
                                  }}
                                >
                                  {GENERATOR_GROUPS.map((group) => (
                                    <optgroup key={group.groupKey} label={t(group.groupKey as never)}>
                                      {group.ids.map((id) => (
                                        <option key={id} value={id}>
                                          {t(generatorLabelKey(id) as never)}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <input
                                  type="checkbox"
                                  checked={!!colSpec.unique}
                                  disabled={running || colSpec.generator === 'skip'}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, colTarget.name, { unique: e.target.checked })
                                  }
                                />
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <input
                                  type="number"
                                  min={0}
                                  max={100}
                                  style={{ width: '62px', textAlign: 'right' }}
                                  value={colSpec.nullPercent ?? 0}
                                  disabled={running || colSpec.generator === 'skip' || !colTarget.nullable}
                                  title={colTarget.nullable ? undefined : t('dataGen.badgeNotNullTitle')}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) =>
                                    patchColumn(activeSpec.table, colTarget.name, {
                                      nullPercent: Number(e.target.value) || 0,
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {/* per-column options */}
            <div className="dgen-pane">
              <div className="dgen-pane-title">{t('dataGen.paneOptions')}</div>
              {!activeColSpec && <div className="dgen-hint" style={{ padding: '10px' }}>{t('dataGen.pickColumnHint')}</div>}
              {activeColSpec && activeSpec && (
                <div className="dgen-pane-body">
                  <div className="dgen-pane-pad">
                    <div style={{ fontSize: '11.5px', fontWeight: 600 }}>
                      {activeColSpec.column}
                      <span className="dgen-dim" style={{ fontWeight: 400 }}>
                        {' '}
                        · {t(generatorLabelKey(activeColSpec.generator) as never)}
                      </span>
                    </div>
                    {activeColTarget?.fk && activeColSpec.generator !== 'foreignKey' && (
                      <div className="dgen-msg warn" style={{ fontSize: '10.5px' }}>
                        <AlertTriangle size={11} />
                        {t('dataGen.fkOverriddenHint', {
                          ref: `${activeColTarget.fk.refTable}.${activeColTarget.fk.refColumn}`,
                        })}
                      </div>
                    )}
                    {optionFields(activeColSpec.generator).map((field) =>
                      renderOptionField(field, activeColSpec, activeSpec.table),
                    )}
                    {isTextGenerator(activeColSpec.generator) && (
                      <>
                        <Field text={t('dataGen.prefix')}>
                          <input
                            value={activeColSpec.prefix ?? ''}
                            onChange={(e) => patchColumn(activeSpec.table, activeColSpec.column, { prefix: e.target.value })}
                          />
                        </Field>
                        <Field text={t('dataGen.suffix')}>
                          <input
                            value={activeColSpec.suffix ?? ''}
                            onChange={(e) => patchColumn(activeSpec.table, activeColSpec.column, { suffix: e.target.value })}
                          />
                        </Field>
                        <Field text={t('dataGen.letterCase')}>
                          <select
                            value={activeColSpec.case ?? ''}
                            onChange={(e) =>
                              patchColumn(activeSpec.table, activeColSpec.column, {
                                case: (e.target.value || undefined) as GenColumnSpec['case'],
                              })
                            }
                          >
                            <option value="">{t('dataGen.caseNone')}</option>
                            <option value="upper">{t('dataGen.caseUpper')}</option>
                            <option value="lower">{t('dataGen.caseLower')}</option>
                            <option value="title">{t('dataGen.caseTitle')}</option>
                          </select>
                        </Field>
                        <Field text={t('dataGen.emptyPercent')}>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={activeColSpec.emptyPercent ?? 0}
                            onChange={(e) =>
                              patchColumn(activeSpec.table, activeColSpec.column, {
                                emptyPercent: Number(e.target.value) || 0,
                              })
                            }
                          />
                        </Field>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ---- issues ---- */}
          {!!issues.length && (
            <div className="dgen-issues">
              {issues.map((issue, idx) => (
                <div
                  key={`${issue.key}-${issue.table ?? ''}-${issue.column ?? ''}-${idx}`}
                  className={`dgen-msg ${issue.level === 'error' ? 'error' : 'warn'}`}
                  style={{ fontSize: '11px' }}
                >
                  <AlertTriangle size={11} /> {t(issue.key as never, issue.params ?? {})}
                </div>
              ))}
            </div>
          )}

          {/* ---- preview ---- */}
          <div className="dgen-pane" style={{ maxHeight: '210px' }}>
            <div className="dgen-pane-title">
              <span>{t('dataGen.panePreview')}</span>
              {previewBusy && <Loader size={11} className="spin" />}
              {/* Seed lives here: it is only interesting next to the data it produced. */}
              <span className="dgen-chip" style={{ marginLeft: 'auto' }} title={t('dataGen.seedHint')}>
                {t('dataGen.seed')} {seed}
                <button
                  className="dgen-icon-btn"
                  disabled={running}
                  title={t('dataGen.seedRandomTitle')}
                  onClick={() => setSeed(rollSeed())}
                >
                  <Dice5 size={12} />
                </button>
              </span>
              <button
                className="dgen-icon-btn"
                disabled={!activeSpec || running}
                title={t('dataGen.previewHint')}
                onClick={() => setPreviewNonce((n) => n + 1)}
              >
                <RefreshCw size={11} />
              </button>
            </div>
            {previewError && (
              <div className="dgen-msg error" style={{ padding: '8px' }}>
                <AlertTriangle size={12} /> {previewError}
              </div>
            )}
            {!previewError && (!preview || !preview.data.length) && (
              <div className="dgen-hint" style={{ padding: '8px' }}>
                {activeSpec ? t('dataGen.previewEmpty') : t('dataGen.pickTableHint')}
              </div>
            )}
            {!previewError && preview && !!preview.data.length && (
              <div className="dgen-pane-body">
                <table className="dgen-table">
                  <thead>
                    <tr>
                      {/* Keyed by POSITION, not name: a result set can carry repeated column names. */}
                      {preview.columns.map((col, i) => (
                        <th key={i}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.map((row, rowIdx) => (
                      <tr key={rowIdx} style={{ cursor: 'default' }}>
                        {preview.columns.map((col, i) => {
                          const v = row[col];
                          return (
                            <td key={i} className="dgen-mono">
                              {v === null || v === undefined ? (
                                // SQL keyword, not UI prose — same as DataGrid's empty cells.
                                <span className="dgen-dim" style={{ fontStyle: 'italic' }}>
                                  {'NULL'}
                                </span>
                              ) : (
                                String(v)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ---- progress / result ---- */}
          {running && (
            <ProgressBar
              progress={{
                label: t('dataGen.progress', {
                  table: progress?.table ?? '',
                  done: formatCount(doneRows, i18n.language),
                  total: formatCount(totalRows, i18n.language),
                }),
                current: doneRows,
                total: totalRows,
                detail:
                  remainingMs === null ? undefined : t('dataGen.eta', { time: formatDuration(remainingMs, t as never) }),
              }}
            />
          )}
          {result && (
            <div className={`dgen-msg ${result.cancelled ? 'warn' : 'ok'}`}>
              <span>
                {result.cancelled
                  ? t('dataGen.resultCancelled', { n: formatCount(insertedTotal, i18n.language) })
                  : t('dataGen.resultDone', {
                      n: formatCount(insertedTotal, i18n.language),
                      time: formatDuration(result.elapsedMs ?? 0, t as never),
                    })}
                {!!result.warnings?.length && <div className="dgen-msg warn">{result.warnings.join(' · ')}</div>}
              </span>
            </div>
          )}
          {runError && (
            <div className="dgen-msg error">
              <AlertTriangle size={12} /> {runError}
            </div>
          )}
        </div>
      </ModalBody>

      <ModalFooter>
        <div className="dgen-foot-db">
          <Database size={12} /> {dbName ?? ''}
        </div>
        {running ? (
          <button
            className="btn btn-secondary"
            onClick={() => { if (jobIdRef.current) cancelJob(jobIdRef.current); }}
          >
            {t('dataGen.cancelRun')}
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose}>
              {t('common.close')}
            </button>
            <button className="btn btn-primary" disabled={!selectedCount || blocked} onClick={() => setConfirming(true)}>
              <Wand2 size={13} /> {t('dataGen.generate')}
            </button>
          </>
        )}
      </ModalFooter>

      <ConfirmDialog
        open={confirming}
        title={t('dataGen.confirmTitle')}
        message={
          truncating
            ? t('dataGen.confirmBodyTruncate', {
                rows: formatCount(totalRows, i18n.language),
                tables: selectedCount,
                db: dbName ?? '',
              })
            : t('dataGen.confirmBody', {
                rows: formatCount(totalRows, i18n.language),
                tables: selectedCount,
                db: dbName ?? '',
              })
        }
        note={truncating ? t('dataGen.confirmNoteTruncate') : undefined}
        confirmLabel={t('dataGen.generate')}
        danger={truncating}
        onConfirm={() => {
          setConfirming(false);
          void run();
        }}
        onCancel={() => setConfirming(false)}
      />
    </Modal>
  );
};
