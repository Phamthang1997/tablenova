import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { ExplainResult } from '../utils/explainHelper';
import { ExplainDiagramView } from './ExplainDiagramView';
import { ExplainGridView } from './ExplainGridView';
import { ExplainTreeView } from './ExplainTreeView';
import { ExplainRawView } from './ExplainRawView';
import { Network, GitFork, FileText, Clock, Zap, Grid3x3 } from 'lucide-react';

type ViewMode = 'diagram' | 'plan' | 'tree' | 'raw';

const VIEW_TABS: { mode: ViewMode; labelKey: 'explain.tabDiagram' | 'explain.tabPlan' | 'explain.tabTree' | 'explain.tabRaw'; Icon: typeof Network }[] = [
  { mode: 'diagram', labelKey: 'explain.tabDiagram', Icon: Network },
  { mode: 'plan', labelKey: 'explain.tabPlan', Icon: Grid3x3 },
  { mode: 'tree', labelKey: 'explain.tabTree', Icon: GitFork },
  { mode: 'raw', labelKey: 'explain.tabRaw', Icon: FileText },
];

interface ExplainViewerProps {
  explainResult: ExplainResult;
  /** Re-runs the plan as FORMAT=JSON, the only MySQL variant that reports cost. */
  onRequestJsonPlan?: () => void;
}

export const ExplainViewer: React.FC<ExplainViewerProps> = ({ explainResult, onRequestJsonPlan }) => {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('diagram');

  const { rawText, rootNode, planningTimeMs, executionTimeMs } = explainResult;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflow: 'hidden' }}>
      {/* Header Bar with View Switcher & Timings */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 12px',
        background: 'var(--win-bg-card)',
        borderBottom: '1px solid var(--win-border)'
      }}>
        {/* View Switcher Segmented Control */}
        <div style={{
          display: 'flex',
          background: 'var(--win-bg-window)',
          padding: '2px',
          borderRadius: '6px',
          border: '1px solid var(--win-border)'
        }}>
          {VIEW_TABS.map(({ mode, labelKey, Icon }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                padding: '3px 10px',
                fontSize: '11px',
                fontWeight: 600,
                border: 'none',
                borderRadius: '4px',
                background: viewMode === mode ? 'var(--win-accent)' : 'transparent',
                color: viewMode === mode ? '#fff' : 'var(--win-text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'all 0.12s ease'
              }}
            >
              <Icon size={12} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </div>

        {/* Timings summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
          {planningTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={12} />
              <span><Trans i18nKey="explain.planningTime" values={{ ms: planningTimeMs.toFixed(2) }} components={{ strong: <strong /> }} /></span>
            </div>
          )}
          {executionTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-ok)' }}>
              <Zap size={12} />
              <span><Trans i18nKey="explain.executionTime" values={{ ms: executionTimeMs.toFixed(2) }} components={{ strong: <strong /> }} /></span>
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {viewMode === 'diagram' && (
          rootNode
            ? <ExplainDiagramView result={explainResult} onRequestJsonPlan={onRequestJsonPlan} />
            : <ExplainRawView rawText={rawText} />
        )}
        {viewMode === 'plan' && (
          rootNode ? <ExplainGridView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
        )}
        {viewMode === 'tree' && (
          rootNode ? <ExplainTreeView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
        )}
        {viewMode === 'raw' && (
          <ExplainRawView rawText={rawText} />
        )}
      </div>
    </div>
  );
};
