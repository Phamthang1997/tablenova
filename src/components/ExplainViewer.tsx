import React, { useState } from 'react';
import type { ExplainResult } from '../utils/explainHelper';
import { ExplainDiagramView } from './ExplainDiagramView';
import { ExplainTreeView } from './ExplainTreeView';
import { ExplainRawView } from './ExplainRawView';
import { Network, GitFork, FileText, Clock, Zap } from 'lucide-react';

interface ExplainViewerProps {
  explainResult: ExplainResult;
}

export const ExplainViewer: React.FC<ExplainViewerProps> = ({ explainResult }) => {
  const [viewMode, setViewMode] = useState<'diagram' | 'tree' | 'raw'>('diagram');

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
          <button
            onClick={() => setViewMode('diagram')}
            style={{
              padding: '3px 10px',
              fontSize: '11px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '4px',
              background: viewMode === 'diagram' ? 'var(--win-accent)' : 'transparent',
              color: viewMode === 'diagram' ? '#fff' : 'var(--win-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.12s ease'
            }}
          >
            <Network size={12} />
            <span>Sơ đồ (Diagram)</span>
          </button>
          <button
            onClick={() => setViewMode('tree')}
            style={{
              padding: '3px 10px',
              fontSize: '11px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '4px',
              background: viewMode === 'tree' ? 'var(--win-accent)' : 'transparent',
              color: viewMode === 'tree' ? '#fff' : 'var(--win-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.12s ease'
            }}
          >
            <GitFork size={12} />
            <span>Dạng cây (Tree)</span>
          </button>
          <button
            onClick={() => setViewMode('raw')}
            style={{
              padding: '3px 10px',
              fontSize: '11px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '4px',
              background: viewMode === 'raw' ? 'var(--win-accent)' : 'transparent',
              color: viewMode === 'raw' ? '#fff' : 'var(--win-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all 0.12s ease'
            }}
          >
            <FileText size={12} />
            <span>Thô (Raw)</span>
          </button>
        </div>

        {/* Timings summary */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '11px', color: 'var(--win-text-secondary)' }}>
          {planningTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <Clock size={12} />
              <span>Lập kế hoạch: <strong>{planningTimeMs.toFixed(2)} ms</strong></span>
            </div>
          )}
          {executionTimeMs !== undefined && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--st-ok)' }}>
              <Zap size={12} />
              <span>Thực thi: <strong>{executionTimeMs.toFixed(2)} ms</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {viewMode === 'diagram' && (
          rootNode ? <ExplainDiagramView rootNode={rootNode} /> : <ExplainRawView rawText={rawText} />
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
