import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExplainNode } from '../utils/explainHelper';
import { ChevronDown, ChevronRight, Table } from 'lucide-react';

interface ExplainTreeViewProps {
  rootNode: ExplainNode;
}

export const ExplainTreeView: React.FC<ExplainTreeViewProps> = ({ rootNode }) => {
  const { t } = useTranslation();
  return (
    <div style={{
      width: '100%',
      height: '100%',
      overflow: 'auto',
      background: 'var(--win-bg-window)',
      padding: '16px'
    }}>
      {/* Table Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 140px 120px 140px 140px',
        padding: '8px 12px',
        background: 'var(--win-bg-card)',
        border: '1px solid var(--win-border)',
        borderRadius: '6px 6px 0 0',
        fontSize: '11px',
        fontWeight: 700,
        color: 'var(--win-text-disabled)',
        textTransform: 'uppercase'
      }}>
        <div>{t('explain.colOperation')}</div>
        <div>{t('explain.colTable')}</div>
        <div>{t('explain.colIndex')}</div>
        <div>{t('explain.colCost')}</div>
        <div>{t('explain.colRows')}</div>
      </div>

      {/* Tree Rows */}
      <div style={{
        border: '1px solid var(--win-border)',
        borderTop: 'none',
        borderRadius: '0 0 6px 6px',
        background: 'var(--win-bg-card)'
      }}>
        <TreeNodeRow node={rootNode} level={0} />
      </div>
    </div>
  );
};

const TreeNodeRow: React.FC<{ node: ExplainNode; level: number }> = ({ node, level }) => {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children && node.children.length > 0;

  const costTotal = node.cost?.total || 0;
  let badgeColor = '#10b981';
  if (costTotal > 1000) badgeColor = '#ef4444';
  else if (costTotal > 100) badgeColor = '#f59e0b';

  return (
    <>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 140px 120px 140px 140px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--win-border)',
        fontSize: '12px',
        alignItems: 'center',
        background: 'transparent',
        transition: 'background 0.1s ease'
      }}>
        {/* Operation with Indentation & Collapse Toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: `${level * 20}px` }}>
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              style={{ background: 'transparent', border: 'none', color: 'var(--win-text-secondary)', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : (
            <div style={{ width: '14px' }} />
          )}
          <span style={{ fontWeight: 600, color: 'var(--win-text-primary)' }}>
            {node.type}
          </span>
        </div>

        {/* Table */}
        <div style={{ color: 'var(--win-text-secondary)', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          {node.table ? (
            <>
              <Table size={12} />
              <span>{node.table}</span>
            </>
          ) : (
            <span style={{ opacity: 0.4 }}>—</span>
          )}
        </div>

        {/* Index */}
        <div style={{ color: 'var(--win-accent)', fontSize: '11.5px' }}>
          {node.indexName || <span style={{ opacity: 0.4, color: 'var(--win-text-disabled)' }}>—</span>}
        </div>

        {/* Cost */}
        <div style={{ fontSize: '11.5px', color: badgeColor, fontWeight: 600 }}>
          {node.cost ? `${node.cost.start.toFixed(1)} .. ${node.cost.total.toFixed(1)}` : '—'}
        </div>

        {/* Rows */}
        <div style={{ fontSize: '11.5px', color: 'var(--win-text-primary)' }}>
          {node.rows !== undefined ? node.rows.toLocaleString('vi-VN') : '—'}
        </div>
      </div>

      {/* Render Sub-nodes */}
      {hasChildren && expanded && (
        node.children!.map(child => (
          <TreeNodeRow key={child.id} node={child} level={level + 1} />
        ))
      )}
    </>
  );
};
