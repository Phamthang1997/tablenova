import React from 'react';
import type { ERRelationship, ERTable, ERLayoutPositions, ERDetailLevel } from './erTypes';
import { getColumnSocketPosition, computeBezierPath } from './erLayoutEngine';

interface ERRelationshipLineProps {
  relationship: ERRelationship;
  sourceTable: ERTable;
  targetTable: ERTable;
  positions: ERLayoutPositions;
  detailLevel: ERDetailLevel;
  isHighlighted: boolean;
  isDimmed: boolean;
  onHover: (relId: string | null) => void;
}

export const ERRelationshipLine: React.FC<ERRelationshipLineProps> = ({
  relationship,
  sourceTable,
  targetTable,
  positions,
  detailLevel,
  isHighlighted,
  isDimmed,
  onHover,
}) => {
  const sourcePos = positions[relationship.sourceTable];
  const targetPos = positions[relationship.targetTable];

  if (!sourcePos || !targetPos) return null;

  const isSourceLeftOfTarget = sourcePos.x + sourcePos.width < targetPos.x;
  const isTargetLeftOfSource = targetPos.x + targetPos.width < sourcePos.x;

  let sourceSide: 'left' | 'right' = 'right';
  let targetSide: 'left' | 'right' = 'left';

  if (isSourceLeftOfTarget) {
    sourceSide = 'right';
    targetSide = 'left';
  } else if (isTargetLeftOfSource) {
    sourceSide = 'left';
    targetSide = 'right';
  } else {
    sourceSide = 'right';
    targetSide = 'right';
  }

  const sourceSocket = getColumnSocketPosition(
    sourcePos,
    sourceTable,
    relationship.sourceColumn,
    sourceSide,
    detailLevel
  );

  const targetSocket = getColumnSocketPosition(
    targetPos,
    targetTable,
    relationship.targetColumn,
    targetSide,
    detailLevel
  );

  const path = computeBezierPath(sourceSocket, targetSocket);

  return (
    <g
      className={`er-rel-group ${isHighlighted ? 'highlighted' : ''} ${isDimmed ? 'dimmed' : ''}`}
      onMouseEnter={() => onHover(relationship.id)}
      onMouseLeave={() => onHover(null)}
    >
      <path d={path} className="er-rel-hitbox" />
      <path
        d={path}
        className="er-rel-path"
        markerStart="url(#er-marker-source-dot)"
        markerEnd="url(#er-marker-target-arrow)"
      />
      <circle cx={targetSocket.x} cy={targetSocket.y} r={3.5} className="er-rel-socket-target" />
      <circle cx={sourceSocket.x} cy={sourceSocket.y} r={3.5} className="er-rel-socket-source" />
    </g>
  );
};
