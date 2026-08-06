import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainFlag, ExplainNode, ExplainResult } from '../utils/explainHelper';
import { planFieldText } from '../utils/explainHelper';
import {
  ArrowDownAZ, Box, Combine, Database, Filter, Hash, KeyRound, Layers,
  LayoutGrid, Repeat, Rows3, Search, Sigma, Table, BarChart2, Clock, FileText, X,
  TriangleAlert, CircleCheck, CircleMinus, Settings2, Braces, ZoomIn, ZoomOut, RotateCcw,
} from 'lucide-react';

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;

const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));

// Costs span a huge range: keep two decimals where they carry information and drop them once the
// integer part is all anyone reads.
function formatCost(value: number, locale: string): string {
  if (value >= 1000) return value.toLocaleString(locale, { maximumFractionDigits: 0 });
  return value.toFixed(2);
}

// Flags that mean "look here", flags that mean "this is fine", and flags that are neither.
const WARN_FLAGS = new Set<ExplainFlag>([
  'fullTableScan', 'noIndexUsed', 'joinBuffer', 'temporaryTable', 'filesort', 'rowsMisestimated',
]);
const GOOD_FLAGS = new Set<ExplainFlag>(['coveringIndex', 'indexCondition']);

// A switch, not a template — i18next keys are type-checked and must stay literal.
function flagLabelKey(flag: ExplainFlag) {
  switch (flag) {
    case 'fullTableScan': return 'explain.flagFullTableScan' as const;
    case 'noIndexUsed': return 'explain.flagNoIndexUsed' as const;
    case 'coveringIndex': return 'explain.flagCoveringIndex' as const;
    case 'indexCondition': return 'explain.flagIndexCondition' as const;
    case 'joinBuffer': return 'explain.flagJoinBuffer' as const;
    case 'temporaryTable': return 'explain.flagTemporaryTable' as const;
    case 'filesort': return 'explain.flagFilesort' as const;
    case 'neverExecuted': return 'explain.flagNeverExecuted' as const;
    case 'rowsMisestimated': return 'explain.flagRowsMisestimated' as const;
    case 'subqueriesHidden': return 'explain.flagSubqueriesHidden' as const;
  }
}

function flagSeverity(flags: ExplainFlag[]): 'warn' | 'good' | 'muted' {
  if (flags.some(f => WARN_FLAGS.has(f))) return 'warn';
  if (flags.some(f => GOOD_FLAGS.has(f))) return 'good';
  return 'muted';
}

// Raw plan fields the panel already renders as their own labelled row, plus the two blobs that
// belong in the Raw tab. Everything else is listed verbatim, so no field is silently dropped.
const PANEL_SURFACED_FIELDS = new Set([
  'table', 'table_name', 'TABLE',
  'key', 'KEY', 'possible_keys', 'POSSIBLE_KEYS',
  'rows_examined_per_scan', 'rows_produced_per_join', 'rows', 'ROWS',
  'attached_condition', 'Filter', 'Extra', 'EXTRA', 'message',
  'Node Type', 'Relation Name', 'Alias', 'Index Name', 'Index Cond',
  'Plan Rows', 'Actual Rows', 'Actual Loops',
  'Startup Cost', 'Total Cost', 'Actual Startup Time', 'Actual Total Time',
  'rawLine', 'raw',
]);

// "a, fa ⋈ s" — which tables this join step combines. Long left sides are abbreviated so the
// node cell stays one line; the full list is in the detail panel.
function joinSummary(node: ExplainNode, maxLeft = 2): string {
  const join = node.joinTables;
  if (!join) return '';
  const left = join.left.length > maxLeft
    ? `${join.left.slice(0, maxLeft).join(', ')}, +${join.left.length - maxLeft}`
    : join.left.join(', ');
  return join.right ? `${left} ⋈ ${join.right}` : left;
}

function remainingFields(node: ExplainNode): [string, string][] {
  return Object.entries(node.details || {})
    .filter(([key]) => !PANEL_SURFACED_FIELDS.has(key))
    .map(([key, value]) => [key, planFieldText(value)] as [string, string | null])
    .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '');
}

interface ExplainDiagramViewProps {
  result: ExplainResult;
  /** MySQL tabular EXPLAIN carries no cost — offer a re-run that does. */
  onRequestJsonPlan?: () => void;
}

// The flow is laid out right-to-left: leaves on the right, the consuming SELECT on the left.
// Every node occupies a cell of exactly ROW_H so the first child always lines up with its
// parent — that is what keeps the top row of the diagram straight.
const ROW_H = 128;
const NODE_W = 140;
const CONN_W = 88;
const LINE = 'var(--win-border-strong, var(--win-border))';

function operatorIcon(type: string) {
  const s = type.toLowerCase();
  if (s === 'select') return LayoutGrid;
  if (s.includes('stream')) return Braces;
  if (s.includes('nested loop')) return Repeat;
  if (s.includes('fulltext')) return Search;
  if (s.includes('lookup') || s.includes('constant row') || s.includes('system row')) return KeyRound;
  if (s.includes('hash')) return Hash;
  if (s.includes('merge')) return Combine;
  if (s.includes('sort') || s.includes('order')) return ArrowDownAZ;
  if (s.includes('group') || s.includes('aggregate')) return Sigma;
  if (s.includes('distinct')) return Layers;
  if (s.includes('filter')) return Filter;
  if (s.includes('search')) return KeyRound;
  if (s.includes('index')) return Rows3;
  if (s.includes('materiali')) return Database;
  if (s.includes('scan')) return Table;
  if (s.includes('plan') || s.includes('execute query')) return LayoutGrid;
  return Box;
}

function percentStyle(pct: number): { color: string; background: string } {
  if (pct >= 25) return { color: '#ef4444', background: 'rgba(239, 68, 68, 0.18)' };
  if (pct >= 15) return { color: '#f59e0b', background: 'rgba(245, 158, 11, 0.18)' };
  if (pct >= 5) return { color: '#84cc16', background: 'rgba(132, 204, 22, 0.18)' };
  return { color: 'var(--win-text-disabled)', background: 'transparent' };
}

function findNode(node: ExplainNode, id: string | null): ExplainNode | null {
  if (!id) return null;
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

interface FlowContext {
  totalSelfCost: number;
  selectedId: string | null;
  onSelect: (node: ExplainNode) => void;
  locale: string;
  flagLabel: (flag: ExplainFlag) => string;
  costLabel: string;
}

export const ExplainDiagramView: React.FC<ExplainDiagramViewProps> = ({ result, onRequestJsonPlan }) => {
  const { t, i18n } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLDivElement>(null);

  // React attaches `wheel` passively, so preventDefault has to come from a native listener —
  // without it Ctrl+wheel zooms the whole app instead of the diagram.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(z => clampZoom(e.deltaY < 0 ? z * ZOOM_STEP : z / ZOOM_STEP));
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const { rootNode, totalSelfCost = 0, totalCostText, settings } = result;
  const settingsText = settings
    ? Object.entries(settings).map(([k, v]) => `${k}=${v}`).join(', ')
    : '';

  // A plan has no terminal operator; dbForge draws the SELECT that consumes the top node.
  const flowRoot = useMemo<ExplainNode | null>(() => {
    if (!rootNode) return null;
    if (rootNode.type === 'Query Execution Plan') return { ...rootNode, type: 'SELECT' };
    return { id: 'select', type: 'SELECT', selfCost: 0, children: [rootNode] };
  }, [rootNode]);

  // Resolving the selection by id (instead of holding the node) means a new plan simply drops
  // the old selection rather than pinning a node that is no longer in the tree.
  const selectedNode = flowRoot ? findNode(flowRoot, selectedId) : null;
  const hasCost = totalSelfCost > 0 && !!totalCostText;

  if (!flowRoot) return null;

  const ctx: FlowContext = {
    totalSelfCost,
    selectedId,
    onSelect: (node) => setSelectedId(node.id),
    locale: i18n.language,
    flagLabel: (flag) => t(flagLabelKey(flag)),
    costLabel: t('explain.colCost'),
  };

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Total cost bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 14px',
          borderBottom: '1px solid var(--win-border)',
          fontSize: '12px',
          color: 'var(--win-text-secondary)',
          flexShrink: 0,
        }}>
          {hasCost ? (
            <span>
              {t('explain.totalCost')}: <strong style={{ color: 'var(--win-text-primary)' }}>{totalCostText}</strong>
            </span>
          ) : (
            <>
              <span>{t('explain.noCostData')}</span>
              {onRequestJsonPlan && (
                <button
                  className="btn btn-secondary"
                  onClick={onRequestJsonPlan}
                  style={{ padding: '2px 8px', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <FileText size={12} />
                  <span>{t('explain.rerunAsJson')}</span>
                </button>
              )}
            </>
          )}

          {/* Non-default planner settings: the usual answer to "why did it pick this plan". */}
          {settingsText && (
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                marginLeft: 'auto',
                marginRight: '4px',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={settingsText}
            >
              <Settings2 size={12} style={{ flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t('explain.settings')}: {settingsText}
              </span>
            </span>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '2px',
            marginLeft: settingsText ? 0 : 'auto',
            flexShrink: 0,
          }}>
            <ZoomButton
              icon={ZoomOut}
              label={t('explain.zoomOut')}
              disabled={zoom <= ZOOM_MIN}
              onClick={() => setZoom(z => clampZoom(z / ZOOM_STEP))}
            />
            <button
              onClick={() => setZoom(1)}
              title={t('explain.zoomReset')}
              aria-label={t('explain.zoomReset')}
              style={{
                minWidth: '44px',
                padding: '2px 4px',
                background: 'transparent',
                border: 'none',
                color: 'var(--win-text-secondary)',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <ZoomButton
              icon={ZoomIn}
              label={t('explain.zoomIn')}
              disabled={zoom >= ZOOM_MAX}
              onClick={() => setZoom(z => clampZoom(z * ZOOM_STEP))}
            />
            <ZoomButton
              icon={RotateCcw}
              label={t('explain.zoomReset')}
              disabled={zoom === 1}
              onClick={() => setZoom(1)}
            />
          </div>
        </div>

        {/* Diagram canvas: width grows with plan depth, so it scrolls horizontally. Uses CSS
            `zoom` rather than `transform: scale` because zoom is layout-aware — the scroll
            extent follows the scaled content instead of staying at the unscaled size. */}
        <div ref={canvasRef} style={{ flex: 1, overflow: 'auto', padding: '20px 16px' }}>
          <div style={{ minWidth: 'max-content', zoom }}>
            <SubTree node={flowRoot} ctx={ctx} />
          </div>
        </div>
      </div>

      {/* Details Side Panel */}
      {selectedNode && (
        <div style={{
          width: '320px',
          flexShrink: 0,
          borderLeft: '1px solid var(--win-border)',
          background: 'var(--win-bg-card)',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          overflowY: 'auto'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--win-border)', paddingBottom: '10px' }}>
            <Layers size={18} style={{ color: 'var(--win-accent)' }} />
            <h4 style={{ margin: 0, fontSize: '14px', color: 'var(--win-text-primary)' }}>
              {t('explain.nodeDetailTitle')}
            </h4>
            {/* Closing the panel just drops the selection — clicking any node opens it again. */}
            <button
              onClick={() => setSelectedId(null)}
              title={t('common.close')}
              aria-label={t('common.close')}
              style={{
                marginLeft: 'auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '22px',
                height: '22px',
                flexShrink: 0,
                padding: 0,
                background: 'transparent',
                border: 'none',
                borderRadius: '4px',
                color: 'var(--win-text-secondary)',
                cursor: 'pointer',
              }}
            >
              <X size={14} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', textTransform: 'uppercase', fontWeight: 600 }}>{t('explain.nodeOperation')}</div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--win-text-primary)', marginTop: '2px' }}>
                {selectedNode.type}
              </div>
            </div>

            {selectedNode.table && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Table size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeTable')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{selectedNode.table}</div>
                </div>
              </div>
            )}

            {selectedNode.joinTables && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeJoin')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)', wordBreak: 'break-word' }}>
                  {/* Full left side here, unlike the abbreviated version on the node itself. */}
                  {joinSummary(selectedNode, Infinity)}
                </div>
              </div>
            )}

            {selectedNode.joinFilter && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeJoinOn')}</div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.joinFilter}
                </div>
              </div>
            )}

            {selectedNode.flags && selectedNode.flags.length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', marginBottom: '5px' }}>{t('explain.flagsTitle')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {selectedNode.flags.map(flag => {
                    const severity = flagSeverity([flag]);
                    const { Icon, color } = FLAG_ICON_STYLE[severity];
                    return (
                      <div key={flag} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', color: severity === 'muted' ? 'var(--win-text-secondary)' : color }}>
                        <Icon size={12} style={{ flexShrink: 0 }} />
                        <span>{t(flagLabelKey(flag))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedNode.indexName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={14} style={{ color: 'var(--win-accent)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeIndex')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-accent)' }}>{selectedNode.indexName}</div>
                </div>
              </div>
            )}

            {selectedNode.candidateIndexes && selectedNode.candidateIndexes.length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeCandidateIndexes')}</div>
                <div style={{ fontSize: '11.5px', color: 'var(--win-text-secondary)' }}>
                  {selectedNode.candidateIndexes.join(', ')}
                </div>
              </div>
            )}

            {selectedNode.cost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BarChart2 size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeCost')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                    {selectedNode.cost.start.toFixed(2)} .. {selectedNode.cost.total.toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {selectedNode.selfCost !== undefined && totalSelfCost > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeSelfCost')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.selfCost.toFixed(2)} ({((selectedNode.selfCost / totalSelfCost) * 100).toFixed(2)}%)
                </div>
              </div>
            )}

            {selectedNode.rows !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeRows')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.rows.toLocaleString(i18n.language)}
                </div>
              </div>
            )}

            {/* The arrow label, spelled out — a join node has no `rows` of its own, which is why
                its panel used to stop after the cost. */}
            {selectedNode.rowsOut !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeRowsOut')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.rowsOut.toLocaleString(i18n.language)}
                </div>
              </div>
            )}

            {selectedNode.actualRowsTotal !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeActualRows')}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.actualRowsTotal.toLocaleString(i18n.language)}
                  {selectedNode.actualLoops !== undefined && selectedNode.actualLoops !== 1 && (
                    // rows × loops: the plan reports rows per loop, which reads far too low.
                    <span style={{ fontWeight: 400, color: 'var(--win-text-secondary)' }}>
                      {' '}({selectedNode.actualRows!.toLocaleString(i18n.language)} × {selectedNode.actualLoops.toLocaleString(i18n.language)} {t('explain.nodeLoops')})
                    </span>
                  )}
                </div>
              </div>
            )}

            {selectedNode.estimateRatio !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeEstimate')}</div>
                <div style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: selectedNode.flags?.includes('rowsMisestimated') ? '#f59e0b' : 'var(--win-text-primary)',
                }}>
                  {selectedNode.estimateRatio >= 1
                    ? `${selectedNode.estimateRatio.toFixed(1)}×`
                    : `1/${(1 / selectedNode.estimateRatio).toFixed(1)}×`}
                </div>
              </div>
            )}

            {selectedNode.actualTime && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Clock size={14} style={{ color: 'var(--st-ok)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>{t('explain.nodeActualTime')}</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--st-ok)' }}>
                    {selectedNode.actualTime.total.toFixed(3)} ms
                  </div>
                </div>
              </div>
            )}

            {selectedNode.message && (
              <div style={{ fontSize: '11.5px', color: '#f59e0b', fontWeight: 600 }}>
                {selectedNode.message}
              </div>
            )}

            {/* Index Cond is evaluated inside the index; Filter runs after the heap fetch. Showing
                them as one field hid which half of the predicate the index actually handles. */}
            {selectedNode.indexCond && (
              <div style={{ background: 'rgba(0,0,0,0.15)', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <KeyRound size={12} />
                  <span>{t('explain.nodeIndexCond')}</span>
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.indexCond}
                </div>
              </div>
            )}

            {selectedNode.filter && (
              <div style={{ background: 'rgba(0,0,0,0.15)', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <Filter size={12} />
                  <span>{t('explain.nodeFilter')}</span>
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.filter}
                </div>
              </div>
            )}

            {/* Whatever the driver reported that has no dedicated row above. Raw field names on
                purpose — they are data, and they are what the docs call them. */}
            {remainingFields(selectedNode).length > 0 && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', marginBottom: '5px', paddingTop: '4px', borderTop: '1px solid var(--win-border)' }}>
                  {t('explain.nodeAllFields')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {remainingFields(selectedNode).map(([key, value]) => (
                    <div key={key} style={{ display: 'flex', gap: '8px', fontSize: '11px', alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--win-text-disabled)', fontFamily: 'var(--win-font-mono)', flexShrink: 0 }}>{key}</span>
                      <span style={{ color: 'var(--win-text-primary)', wordBreak: 'break-word', textAlign: 'right', marginLeft: 'auto' }} title={value}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const SubTree: React.FC<{ node: ExplainNode; ctx: FlowContext }> = ({ node, ctx }) => {
  const children = node.children || [];

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <NodeCell node={node} ctx={ctx} />

      {children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {children.map((child, i) => (
            // Each child row brings its own connector segment. The segments join up into one
            // continuous spine without anyone having to measure subtree heights.
            <div key={child.id} style={{ display: 'flex', alignItems: 'stretch' }}>
              <Connector
                // What the child hands upwards, not what it reads: an arrow label of
                // rows-per-scan says nothing about the volume flowing through the join.
                rows={child.actualRows ?? child.rowsOut ?? child.rows}
                isFirst={i === 0}
                isLast={i === children.length - 1}
                single={children.length === 1}
                locale={ctx.locale}
              />
              <SubTree node={child} ctx={ctx} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const Connector: React.FC<{
  rows?: number;
  isFirst: boolean;
  isLast: boolean;
  single: boolean;
  locale: string;
}> = ({ rows, isFirst, isLast, single, locale }) => (
  <div style={{ position: 'relative', width: `${CONN_W}px`, minHeight: `${ROW_H}px`, flexShrink: 0 }}>
    {/* Vertical spine: first child runs from its centreline down, the last one from the top to
        its centreline, everything in between spans the full height. */}
    {!single && (
      <div style={{
        position: 'absolute',
        left: 0,
        width: '1px',
        background: LINE,
        top: isFirst ? `${ROW_H / 2}px` : 0,
        ...(isLast ? { height: `${ROW_H / 2}px` } : { bottom: 0 }),
      }} />
    )}

    {/* Horizontal segment at this child's centreline */}
    <div style={{ position: 'absolute', top: `${ROW_H / 2}px`, left: 0, right: 0, height: '1px', background: LINE }} />

    {/* Arrowhead only where the flow actually enters the parent operator */}
    {isFirst && (
      <div style={{
        position: 'absolute',
        top: `${ROW_H / 2 - 4}px`,
        left: 0,
        width: 0,
        height: 0,
        borderTop: '4px solid transparent',
        borderBottom: '4px solid transparent',
        borderRight: `6px solid ${LINE}`,
      }} />
    )}

    {/* Rows handed to the parent */}
    {rows !== undefined && (
      <div style={{
        position: 'absolute',
        top: `${ROW_H / 2 - 20}px`,
        left: 0,
        right: 0,
        textAlign: 'center',
        fontSize: '11px',
        color: 'var(--win-text-secondary)',
      }}>
        {rows.toLocaleString(locale)}
      </div>
    )}
  </div>
);

const ZoomButton: React.FC<{
  icon: typeof ZoomIn;
  label: string;
  disabled: boolean;
  onClick: () => void;
}> = ({ icon: Icon, label, disabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '22px',
      height: '22px',
      padding: 0,
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      color: 'var(--win-text-secondary)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.4 : 1,
    }}
  >
    <Icon size={13} />
  </button>
);

const FLAG_ICON_STYLE = {
  warn: { Icon: TriangleAlert, color: '#f59e0b' },
  good: { Icon: CircleCheck, color: '#22c55e' },
  muted: { Icon: CircleMinus, color: 'var(--win-text-disabled)' },
} as const;

const FlagIcon: React.FC<{ flags: ExplainFlag[]; ctx: FlowContext }> = ({ flags, ctx }) => {
  const { Icon, color } = FLAG_ICON_STYLE[flagSeverity(flags)];
  // Lucide icons take no `title`, so the tooltip lives on a wrapper.
  return (
    <span style={{ display: 'flex', alignItems: 'center' }} title={flags.map(ctx.flagLabel).join(' · ')}>
      <Icon size={12} style={{ color, flexShrink: 0 }} />
    </span>
  );
};

const NodeCell: React.FC<{ node: ExplainNode; ctx: FlowContext }> = ({ node, ctx }) => {
  const Icon = operatorIcon(node.type);
  const selected = ctx.selectedId === node.id;
  const pct = ctx.totalSelfCost > 0 && node.selfCost !== undefined
    ? (node.selfCost / ctx.totalSelfCost) * 100
    : undefined;
  const badge = pct !== undefined && pct >= 0.005 ? percentStyle(pct) : null;
  const flags = node.flags || [];

  return (
    <div
      onClick={() => ctx.onSelect(node)}
      style={{
        width: `${NODE_W}px`,
        height: `${ROW_H}px`,
        flexShrink: 0,
        cursor: 'pointer',
        borderRadius: '6px',
        background: selected ? 'rgba(0, 102, 204, 0.12)' : 'transparent',
        outline: selected ? '1px solid var(--win-accent)' : 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '3px',
        padding: '4px 2px',
        boxSizing: 'border-box',
        // A very long operator name is clipped rather than allowed to bleed into the neighbour;
        // the full text stays reachable through the title attribute and the detail panel.
        overflow: 'hidden',
      }}
    >
      {/* Relative cost badge, reserved height so every icon stays on the same baseline */}
      <div style={{ height: '16px', display: 'flex', alignItems: 'center', gap: '4px' }}>
        {badge && (
          <span style={{
            fontSize: '10px',
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: '3px',
            color: badge.color,
            background: badge.background,
          }}>
            {pct!.toFixed(2)}%
          </span>
        )}
        {/* One icon summarising the node's signals — the full list is in the detail panel. Keeping
            it to a single glyph is what lets a wide plan stay readable. */}
        {flags.length > 0 && <FlagIcon flags={flags} ctx={ctx} />}
      </div>

      <Icon size={26} style={{ color: selected ? 'var(--win-accent)' : 'var(--win-text-primary)', flexShrink: 0 }} />

      <div
        style={{
          fontSize: '11.5px',
          fontWeight: 600,
          color: 'var(--win-text-primary)',
          textAlign: 'center',
          lineHeight: 1.25,
          wordBreak: 'break-word',
        }}
        title={node.type}
      >
        {node.type}
      </div>

      {/* A join has no table of its own; name the two sides instead of leaving the line blank. */}
      {(node.table || node.joinTables) && (
        <div
          style={{
            fontSize: '10.5px',
            color: 'var(--win-text-secondary)',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={node.table || joinSummary(node)}
        >
          {node.table || joinSummary(node)}
        </div>
      )}

      {/* The absolute figure behind the % badge — same quantity, so the two always agree. */}
      {node.selfCost !== undefined && node.selfCost > 0 && (
        <div style={{ fontSize: '10px', color: 'var(--win-text-disabled)', whiteSpace: 'nowrap' }}>
          {ctx.costLabel}: {formatCost(node.selfCost, ctx.locale)}
        </div>
      )}
    </div>
  );
};
