import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type {
  ERTable,
  ERRelationship,
  ERLayoutPositions,
  ERViewport,
  ERDetailLevel,
  ERExportFormat,
} from './erTypes';
import { computeAutoLayout, computeDiagramBounds } from './erLayoutEngine';
import { loadSavedLayout, saveCurrentLayout } from './erPersistence';
import {
  exportToMermaid,
  exportToDbml,
  exportToSql,
  captureDiagramToPng,
  downloadFile,
} from './erExportHelper';
import { ERTableNode } from './ERTableNode';
import { ERRelationshipLine } from './ERRelationshipLine';
import { ERToolbar } from './ERToolbar';
import { ERMinimap } from './ERMinimap';

export interface ERDiagramViewProps {
  connId: string;
  database?: string;
  schema?: string;
  tables: ERTable[];
  relationships: ERRelationship[];
  onOpenTable?: (tableName: string) => void;
  isLoading?: boolean;
}

export const ERDiagramView: React.FC<ERDiagramViewProps> = ({
  connId,
  database,
  schema,
  tables,
  relationships,
  onOpenTable,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Viewport State (Pan & Zoom)
  const [viewport, setViewport] = useState<ERViewport>({ x: 40, y: 40, zoom: 1 });
  const [positions, setPositions] = useState<ERLayoutPositions>(() => {
    if (tables.length === 0) return {};
    const saved = loadSavedLayout(connId, database, schema);
    if (saved && Object.keys(saved).length > 0) return saved;
    return computeAutoLayout(tables, relationships, 'full');
  });
  const [detailLevel, setDetailLevel] = useState<ERDetailLevel>('full');
  const [showViews, setShowViews] = useState(true);
  const [showIsolated, setShowIsolated] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(new Set());
  const [highlightedTable, setHighlightedTable] = useState<string | null>(null);
  const [highlightedRelation, setHighlightedRelation] = useState<string | null>(null);
  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({});

  // Dragging State
  const dragRef = useRef<{
    type: 'canvas' | 'node';
    nodeId?: string;
    startX: number;
    startY: number;
    initialVpX?: number;
    initialVpY?: number;
    initialNodePos?: Record<string, { x: number; y: number }>;
  } | null>(null);

  // Container dimensions
  const [dimensions, setDimensions] = useState({ width: 1200, height: 800 });

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth || 1200,
          height: containerRef.current.clientHeight || 800,
        });
      }
    };
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // Filter visible tables
  const visibleTables = useMemo(() => {
    let list = tables;
    if (!showViews) {
      list = list.filter((table) => table.kind !== 'view');
    }
    if (!showIsolated) {
      const connectedTables = new Set<string>();
      relationships.forEach((rel) => {
        connectedTables.add(rel.sourceTable);
        connectedTables.add(rel.targetTable);
      });
      list = list.filter((table) => connectedTables.has(table.name));
    }
    return list;
  }, [tables, relationships, showViews, showIsolated]);

  // Initial layout calculation (Loads saved layout or computes auto-layout)
  useEffect(() => {
    if (visibleTables.length === 0) return;

    queueMicrotask(() => {
      const saved = loadSavedLayout(connId, database, schema);
      if (saved && Object.keys(saved).length > 0) {
        setPositions(saved);
      } else {
        const autoPos = computeAutoLayout(visibleTables, relationships, detailLevel, collapsedMap);
        setPositions(autoPos);
        saveCurrentLayout(connId, autoPos, database, schema);
      }
    });
  }, [connId, database, schema, visibleTables, relationships, detailLevel, collapsedMap]);

  // Recalculate auto-layout when requested
  const handleAutoLayout = useCallback(() => {
    const autoPos = computeAutoLayout(visibleTables, relationships, detailLevel, collapsedMap);
    setPositions(autoPos);
    saveCurrentLayout(connId, autoPos, database, schema);
  }, [visibleTables, relationships, detailLevel, collapsedMap, connId, database, schema]);

  // Zoom handlers
  const handleZoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    setViewport((prev) => {
      const newZoom = Math.min(Math.max(prev.zoom * factor, 0.2), 2.5);
      if (clientX !== undefined && clientY !== undefined && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = clientX - rect.left;
        const mouseY = clientY - rect.top;

        const newX = mouseX - (mouseX - prev.x) * (newZoom / prev.zoom);
        const newY = mouseY - (mouseY - prev.y) * (newZoom / prev.zoom);
        return { x: newX, y: newY, zoom: newZoom };
      }
      return { ...prev, zoom: newZoom };
    });
  }, []);

  const handleFitView = useCallback(() => {
    const bounds = computeDiagramBounds(positions);
    const padding = 80;
    const availableWidth = dimensions.width - padding * 2;
    const availableHeight = dimensions.height - padding * 2;

    const scaleX = availableWidth / bounds.width;
    const scaleY = availableHeight / bounds.height;
    const newZoom = Math.min(Math.max(Math.min(scaleX, scaleY), 0.3), 1.2);

    const newX = (dimensions.width - bounds.width * newZoom) / 2 - bounds.minX * newZoom;
    const newY = (dimensions.height - bounds.height * newZoom) / 2 - bounds.minY * newZoom;

    setViewport({ x: newX, y: newY, zoom: newZoom });
  }, [positions, dimensions]);

  const handleResetView = useCallback(() => {
    setViewport({ x: 40, y: 40, zoom: 1 });
  }, []);

  // Search and fly-to table
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) return;

    const matched = visibleTables.find(
      (table) =>
        table.name.toLowerCase().includes(query.toLowerCase()) ||
        table.columns.some((col) => col.name.toLowerCase().includes(query.toLowerCase()))
    );

    if (matched && positions[matched.name]) {
      const pos = positions[matched.name];
      const targetX = dimensions.width / 2 - (pos.x + pos.width / 2) * viewport.zoom;
      const targetY = dimensions.height / 2 - (pos.y + pos.height / 2) * viewport.zoom;
      setViewport((prev) => ({ ...prev, x: targetX, y: targetY }));
      setSelectedTableIds(new Set([matched.name]));
    }
  };

  // Canvas Mouse / Wheel Interactions
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      handleZoom(factor, e.clientX, e.clientY);
    } else {
      setViewport((prev) => ({
        ...prev,
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      }));
    }
  };

  const handleMouseDownCanvas = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if ((e.target as HTMLElement).closest('.er-table-node') || (e.target as HTMLElement).closest('.er-toolbar-container')) {
      return;
    }

    dragRef.current = {
      type: 'canvas',
      startX: e.clientX,
      startY: e.clientY,
      initialVpX: viewport.x,
      initialVpY: viewport.y,
    };

    if (!e.shiftKey) {
      setSelectedTableIds(new Set());
    }
  };

  const handleMouseDownNode = (tableName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;

    const currentSelection = new Set(selectedTableIds);
    if (e.shiftKey) {
      if (currentSelection.has(tableName)) currentSelection.delete(tableName);
      else currentSelection.add(tableName);
    } else if (!currentSelection.has(tableName)) {
      currentSelection.clear();
      currentSelection.add(tableName);
    }
    setSelectedTableIds(currentSelection);

    const initialPos: Record<string, { x: number; y: number }> = {};
    currentSelection.forEach((id) => {
      if (positions[id]) initialPos[id] = { x: positions[id].x, y: positions[id].y };
    });

    dragRef.current = {
      type: 'node',
      nodeId: tableName,
      startX: e.clientX,
      startY: e.clientY,
      initialNodePos: initialPos,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;

    if (dragRef.current.type === 'canvas') {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setViewport((prev) => ({
        ...prev,
        x: (dragRef.current?.initialVpX ?? 0) + dx,
        y: (dragRef.current?.initialVpY ?? 0) + dy,
      }));
    } else if (dragRef.current.type === 'node' && dragRef.current.initialNodePos) {
      const dx = (e.clientX - dragRef.current.startX) / viewport.zoom;
      const dy = (e.clientY - dragRef.current.startY) / viewport.zoom;

      const newPos = { ...positions };
      Object.entries(dragRef.current.initialNodePos).forEach(([id, init]) => {
        if (newPos[id]) {
          newPos[id] = {
            ...newPos[id],
            x: Math.round(init.x + dx),
            y: Math.round(init.y + dy),
          };
        }
      });
      setPositions(newPos);
    }
  };

  const handleMouseUp = () => {
    if (dragRef.current?.type === 'node') {
      saveCurrentLayout(connId, positions, database, schema);
    }
    dragRef.current = null;
  };

  // Toggle Collapse Table
  const handleToggleCollapse = (tableName: string) => {
    const isNowCollapsed = !collapsedMap[tableName];
    const newCollapsed = { ...collapsedMap, [tableName]: isNowCollapsed };
    setCollapsedMap(newCollapsed);

    if (positions[tableName]) {
      const table = visibleTables.find((item) => item.name === tableName);
      if (table) {
        const { width, height } = computeAutoLayout([table], [], detailLevel, newCollapsed)[tableName] || {
          width: 260,
          height: 38,
        };
        setPositions((prev) => ({
          ...prev,
          [tableName]: { ...prev[tableName], width, height, isCollapsed: isNowCollapsed },
        }));
      }
    }
  };

  // Related tables helper for highlight effects
  const tableRelationshipSet = useMemo(() => {
    const relMap = new Map<string, Set<string>>();
    relationships.forEach((rel) => {
      if (!relMap.has(rel.sourceTable)) relMap.set(rel.sourceTable, new Set());
      if (!relMap.has(rel.targetTable)) relMap.set(rel.targetTable, new Set());
      relMap.get(rel.sourceTable)?.add(rel.targetTable);
      relMap.get(rel.targetTable)?.add(rel.sourceTable);
    });
    return relMap;
  }, [relationships]);

  // Export handlers
  const handleExport = async (format: ERExportFormat) => {
    const baseName = `${database || 'database'}_er_diagram`;

    switch (format) {
      case 'mermaid': {
        const markdown = exportToMermaid(visibleTables, relationships);
        await navigator.clipboard.writeText(markdown);
        break;
      }
      case 'dbml': {
        const dbml = exportToDbml(visibleTables, relationships);
        downloadFile(dbml, `${baseName}.dbml`, 'text/plain');
        break;
      }
      case 'sql': {
        const sql = exportToSql(visibleTables, relationships);
        downloadFile(sql, `${baseName}.sql`, 'text/plain');
        break;
      }
      case 'svg': {
        if (!svgRef.current) return;
        const svgContent = new XMLSerializer().serializeToString(svgRef.current);
        downloadFile(svgContent, `${baseName}.svg`, 'image/svg+xml');
        break;
      }
      case 'png':
      case 'clipboard': {
        if (!svgRef.current) return;
        try {
          const { blob } = await captureDiagramToPng(svgRef.current, 2.0);
          if (format === 'clipboard') {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          } else {
            downloadFile(blob, `${baseName}.png`, 'image/png');
          }
        } catch (err) {
          console.error('Export PNG failed:', err);
        }
        break;
      }
    }
  };

  const tableMap = useMemo(() => {
    const map = new Map<string, ERTable>();
    visibleTables.forEach((table) => map.set(table.name, table));
    return map;
  }, [visibleTables]);

  return (
    <div
      className="er-diagram-container"
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDownCanvas}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Top Floating Toolbar */}
      <ERToolbar
        zoom={viewport.zoom}
        tableCount={visibleTables.length}
        relationCount={relationships.length}
        searchQuery={searchQuery}
        detailLevel={detailLevel}
        showViews={showViews}
        showIsolated={showIsolated}
        showMinimap={showMinimap}
        onZoomIn={() => handleZoom(1.15)}
        onZoomOut={() => handleZoom(0.85)}
        onFitView={handleFitView}
        onResetView={handleResetView}
        onAutoLayout={handleAutoLayout}
        onSearchChange={handleSearchChange}
        onDetailLevelChange={setDetailLevel}
        onToggleViews={() => setShowViews(!showViews)}
        onToggleIsolated={() => setShowIsolated(!showIsolated)}
        onToggleMinimap={() => setShowMinimap(!showMinimap)}
        onExport={handleExport}
      />

      {/* Infinite Canvas Viewport */}
      <div
        className="er-canvas-layer"
        style={{
          transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        {/* SVG Connector Layer */}
        <svg
          ref={svgRef}
          className="er-svg-connectors-layer"
          width={50000}
          height={50000}
          style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
        >
          <defs>
            <marker
              id="er-marker-target-arrow"
              viewBox="0 0 10 10"
              refX="6"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="var(--win-accent)" />
            </marker>
            <marker
              id="er-marker-source-dot"
              viewBox="0 0 10 10"
              refX="5"
              refY="5"
              markerWidth="5"
              markerHeight="5"
            >
              <circle cx="5" cy="5" r="3" fill="var(--win-accent)" />
            </marker>
          </defs>

          {relationships.map((rel) => {
            const src = tableMap.get(rel.sourceTable);
            const tgt = tableMap.get(rel.targetTable);
            if (!src || !tgt) return null;

            const isHighlighted =
              highlightedRelation === rel.id ||
              highlightedTable === rel.sourceTable ||
              highlightedTable === rel.targetTable;

            const isDimmed =
              (highlightedTable !== null && !isHighlighted) ||
              (highlightedRelation !== null && highlightedRelation !== rel.id);

            return (
              <ERRelationshipLine
                key={rel.id}
                relationship={rel}
                sourceTable={src}
                targetTable={tgt}
                positions={positions}
                detailLevel={detailLevel}
                isHighlighted={isHighlighted}
                isDimmed={isDimmed}
                onHover={setHighlightedRelation}
              />
            );
          })}
        </svg>

        {/* HTML Table Nodes Layer */}
        <div className="er-nodes-layer">
          {visibleTables.map((table) => {
            const pos = positions[table.name];
            if (!pos) return null;

            const isSelected = selectedTableIds.has(table.name);
            const isRelatedToHovered =
              highlightedTable !== null &&
              (highlightedTable === table.name ||
                tableRelationshipSet.get(highlightedTable)?.has(table.name));

            const isDimmed = highlightedTable !== null && !isRelatedToHovered;

            return (
              <ERTableNode
                key={table.name}
                table={table}
                position={pos}
                detailLevel={detailLevel}
                isSelected={isSelected}
                isHighlighted={!!isRelatedToHovered}
                isDimmed={!!isDimmed}
                onSelect={(name, e) => {
                  if (e.shiftKey) {
                    setSelectedTableIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(name)) next.delete(name);
                      else next.add(name);
                      return next;
                    });
                  } else {
                    setSelectedTableIds(new Set([name]));
                  }
                }}
                onToggleCollapse={handleToggleCollapse}
                onDoubleClick={(name) => onOpenTable && onOpenTable(name)}
                onHover={setHighlightedTable}
                onMouseDown={handleMouseDownNode}
              />
            );
          })}
        </div>
      </div>

      {/* Bottom Right Radar Minimap */}
      {showMinimap && Object.keys(positions).length > 0 && (
        <ERMinimap
          positions={positions}
          viewport={viewport}
          containerWidth={dimensions.width}
          containerHeight={dimensions.height}
          onPanTo={(newX, newY) => setViewport((prev) => ({ ...prev, x: newX, y: newY }))}
        />
      )}
    </div>
  );
};
