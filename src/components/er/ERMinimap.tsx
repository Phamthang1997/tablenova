import React, { useRef } from 'react';
import type { ERLayoutPositions, ERViewport } from './erTypes';
import { computeDiagramBounds } from './erLayoutEngine';

interface ERMinimapProps {
  positions: ERLayoutPositions;
  viewport: ERViewport;
  containerWidth: number;
  containerHeight: number;
  onPanTo: (x: number, y: number) => void;
}

const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 120;
const PADDING = 20;

export const ERMinimap: React.FC<ERMinimapProps> = ({
  positions,
  viewport,
  containerWidth,
  containerHeight,
  onPanTo,
}) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const bounds = computeDiagramBounds(positions);

  const totalWidth = bounds.width + PADDING * 2;
  const totalHeight = bounds.height + PADDING * 2;

  const scaleX = MINIMAP_WIDTH / totalWidth;
  const scaleY = MINIMAP_HEIGHT / totalHeight;
  const mapScale = Math.min(scaleX, scaleY);

  const offsetX = (MINIMAP_WIDTH - totalWidth * mapScale) / 2;
  const offsetY = (MINIMAP_HEIGHT - totalHeight * mapScale) / 2;

  const vpX = ((-viewport.x / viewport.zoom) - (bounds.minX - PADDING)) * mapScale + offsetX;
  const vpY = ((-viewport.y / viewport.zoom) - (bounds.minY - PADDING)) * mapScale + offsetY;
  const vpW = (containerWidth / viewport.zoom) * mapScale;
  const vpH = (containerHeight / viewport.zoom) * mapScale;

  const handleMinimapClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!minimapRef.current) return;
    const rect = minimapRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left - offsetX;
    const clickY = e.clientY - rect.top - offsetY;

    const targetWorldX = clickX / mapScale + (bounds.minX - PADDING);
    const targetWorldY = clickY / mapScale + (bounds.minY - PADDING);

    const newViewportX = -(targetWorldX * viewport.zoom - containerWidth / 2);
    const newViewportY = -(targetWorldY * viewport.zoom - containerHeight / 2);

    onPanTo(newViewportX, newViewportY);
  };

  return (
    <div className="er-minimap-container" ref={minimapRef} onClick={handleMinimapClick}>
      <svg width={MINIMAP_WIDTH} height={MINIMAP_HEIGHT} className="er-minimap-svg">
        {Object.entries(positions).map(([tableName, pos]) => {
          const x = (pos.x - (bounds.minX - PADDING)) * mapScale + offsetX;
          const y = (pos.y - (bounds.minY - PADDING)) * mapScale + offsetY;
          const w = Math.max(pos.width * mapScale, 4);
          const h = Math.max(pos.height * mapScale, 3);

          return (
            <rect
              key={tableName}
              x={x}
              y={y}
              width={w}
              height={h}
              rx={1.5}
              className="er-minimap-node"
            />
          );
        })}

        <rect
          x={Math.max(0, vpX)}
          y={Math.max(0, vpY)}
          width={Math.min(MINIMAP_WIDTH, Math.max(8, vpW))}
          height={Math.min(MINIMAP_HEIGHT, Math.max(8, vpH))}
          className="er-minimap-viewport"
        />
      </svg>
    </div>
  );
};
