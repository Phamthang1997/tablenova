import React, { useState } from 'react';
import type { ExplainNode } from '../utils/explainHelper';
import { Layers, Table, Database, Clock, BarChart2, Filter } from 'lucide-react';

interface ExplainDiagramViewProps {
  rootNode: ExplainNode;
}

export const ExplainDiagramView: React.FC<ExplainDiagramViewProps> = ({ rootNode }) => {
  const [selectedNode, setSelectedNode] = useState<ExplainNode>(rootNode);

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', background: 'var(--win-bg-window)' }}>
      {/* Diagram Canvas */}
      <div style={{ flex: 1, padding: '24px 16px', overflow: 'auto', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', minWidth: 'max-content', padding: '0 16px' }}>
          <DiagramNodeTree node={rootNode} selectedId={selectedNode.id} onSelect={setSelectedNode} />
        </div>
      </div>

      {/* Details Side Panel */}
      {selectedNode && (
        <div style={{
          width: '320px',
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
              Chi tiết Thao tác (Node Detail)
            </h4>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', textTransform: 'uppercase', fontWeight: 600 }}>Loại thao tác</div>
              <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--win-text-primary)', marginTop: '2px' }}>
                {selectedNode.type}
              </div>
            </div>

            {selectedNode.table && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Table size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>Bảng truy vấn</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>{selectedNode.table}</div>
                </div>
              </div>
            )}

            {selectedNode.indexName && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Database size={14} style={{ color: 'var(--win-accent)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>Chỉ mục (Index)</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-accent)' }}>{selectedNode.indexName}</div>
                </div>
              </div>
            )}

            {selectedNode.cost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BarChart2 size={14} style={{ color: 'var(--win-text-secondary)' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>Chi phí (Cost)</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                    {selectedNode.cost.start.toFixed(2)} .. {selectedNode.cost.total.toFixed(2)}
                  </div>
                </div>
              </div>
            )}

            {selectedNode.rows !== undefined && (
              <div>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>Số dòng ước tính (Rows)</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--win-text-primary)' }}>
                  {selectedNode.rows.toLocaleString('vi-VN')} dòng
                </div>
              </div>
            )}

            {selectedNode.actualTime && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Clock size={14} style={{ color: '#10b981' }} />
                <div>
                  <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>Thời gian thực tế (Actual Time)</div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: '#10b981' }}>
                    {selectedNode.actualTime.total.toFixed(3)} ms
                  </div>
                </div>
              </div>
            )}

            {selectedNode.filter && (
              <div style={{ background: 'rgba(0,0,0,0.15)', padding: '8px 10px', borderRadius: '4px', border: '1px solid var(--win-border)' }}>
                <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                  <Filter size={12} />
                  <span>Điều kiện lọc (Filter)</span>
                </div>
                <div style={{ fontSize: '11px', fontFamily: 'var(--win-font-mono)', color: 'var(--win-text-primary)', wordBreak: 'break-all' }}>
                  {selectedNode.filter}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const DiagramNodeTree: React.FC<{
  node: ExplainNode;
  selectedId: string;
  onSelect: (node: ExplainNode) => void;
}> = ({ node, selectedId, onSelect }) => {
  const isSelected = selectedId === node.id;
  const cost = node.cost?.total || 0;

  // Cost color badge
  let badgeColor = '#10b981'; // green
  if (node.costSeverity === 'high' || cost > 1000) badgeColor = '#ef4444'; // red
  else if (node.costSeverity === 'medium' || cost > 100) badgeColor = '#f59e0b'; // orange
  else if (node.costSeverity === 'low') badgeColor = '#10b981';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
      {/* Node Box */}
      <div
        onClick={() => onSelect(node)}
        style={{
          background: isSelected ? 'rgba(0, 102, 204, 0.15)' : 'var(--win-bg-card)',
          border: isSelected ? '2px solid var(--win-accent)' : `1px solid ${badgeColor}`,
          borderRadius: '8px',
          padding: '10px 14px',
          minWidth: '180px',
          maxWidth: '250px',
          boxShadow: isSelected ? '0 0 12px rgba(0, 102, 204, 0.4)' : '0 4px 12px rgba(0,0,0,0.25)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              fontSize: '12px',
              fontWeight: 700,
              color: 'var(--win-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1
            }}
            title={node.type}
          >
            {node.type}
          </span>
          <span style={{
            fontSize: '9.5px',
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: '10px',
            background: `${badgeColor}22`,
            color: badgeColor,
            border: `1px solid ${badgeColor}44`,
            flexShrink: 0
          }}>
            {cost > 0 ? `Cost: ${cost.toFixed(1)}` : 'Node'}
          </span>
        </div>

        {node.table && (
          <div style={{ fontSize: '11px', color: 'var(--win-text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Table size={12} />
            <span>{node.table}</span>
          </div>
        )}

        {node.rows !== undefined && (
          <div style={{ fontSize: '10.5px', color: 'var(--win-text-disabled)' }}>
            Dòng ước tính: <strong>{node.rows.toLocaleString('vi-VN')}</strong>
          </div>
        )}
      </div>

      {/* Children Nodes & Flow Arrows */}
      {node.children && node.children.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', width: '100%' }}>
          {/* Connector Down Arrow */}
          <div style={{ width: '2px', height: '16px', background: 'var(--win-border)' }} />

          <div style={{ display: 'flex', gap: '24px', justifyContent: 'center' }}>
            {node.children.map((child) => (
              <DiagramNodeTree key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
