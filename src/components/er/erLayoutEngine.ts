/**
 * ER Diagram Auto-Layout Engine.
 * Implements hierarchical DAG layout, topological layering, collision avoidance,
 * and smart socket routing for relationship connector lines.
 */

import type { ERTable, ERRelationship, ERNodePosition, ERLayoutPositions, ERDetailLevel } from './erTypes';

export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 24;
export const FOOTER_HEIGHT = 6;
export const DEFAULT_NODE_WIDTH = 260;
export const HORIZONTAL_SPACING = 120;
export const VERTICAL_SPACING = 60;

/**
 * Calculates node dimensions based on columns and detail level.
 */
export function calculateNodeDimensions(
  table: ERTable,
  detailLevel: ERDetailLevel = 'full',
  isCollapsed: boolean = false
): { width: number; height: number } {
  if (isCollapsed) {
    return { width: DEFAULT_NODE_WIDTH, height: HEADER_HEIGHT };
  }

  let visibleColumns = table.columns;
  if (detailLevel === 'keys_only') {
    visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
    if (visibleColumns.length === 0) {
      visibleColumns = table.columns.slice(0, 3);
    }
  } else if (detailLevel === 'compact') {
    visibleColumns = table.columns.slice(0, 5);
  }

  const height = HEADER_HEIGHT + visibleColumns.length * ROW_HEIGHT + FOOTER_HEIGHT;
  return { width: DEFAULT_NODE_WIDTH, height };
}

/**
 * Automatically computes hierarchical layout for all tables using DAG topological layering.
 */
export function computeAutoLayout(
  tables: ERTable[],
  relationships: ERRelationship[],
  detailLevel: ERDetailLevel = 'full',
  collapsedMap: Record<string, boolean> = {}
): ERLayoutPositions {
  if (tables.length === 0) return {};

  const tableMap = new Map<string, ERTable>();
  tables.forEach((table) => tableMap.set(table.name, table));

  // Build in-degree and adjacency map for DAG layering
  const inDegree: Record<string, number> = {};
  const adj: Record<string, string[]> = {};
  const revAdj: Record<string, string[]> = {};

  tables.forEach((table) => {
    inDegree[table.name] = 0;
    adj[table.name] = [];
    revAdj[table.name] = [];
  });

  relationships.forEach((rel) => {
    if (tableMap.has(rel.sourceTable) && tableMap.has(rel.targetTable) && rel.sourceTable !== rel.targetTable) {
      adj[rel.targetTable].push(rel.sourceTable);
      revAdj[rel.sourceTable].push(rel.targetTable);
      inDegree[rel.sourceTable] = (inDegree[rel.sourceTable] || 0) + 1;
    }
  });

  // Calculate layers (Rank by depth from root tables)
  const layers: string[][] = [];
  const visited = new Set<string>();

  let currentLayer = tables.filter((table) => inDegree[table.name] === 0).map((table) => table.name);
  if (currentLayer.length === 0) {
    currentLayer = [tables[0].name];
  }

  while (currentLayer.length > 0) {
    layers.push(currentLayer);
    currentLayer.forEach((name) => visited.add(name));

    const nextLayerSet = new Set<string>();
    currentLayer.forEach((name) => {
      (adj[name] || []).forEach((child) => {
        if (!visited.has(child)) {
          const parents = revAdj[child] || [];
          const allParentsVisited = parents.every((parentName) => visited.has(parentName));
          if (allParentsVisited || nextLayerSet.size < 6) {
            nextLayerSet.add(child);
          }
        }
      });
    });

    currentLayer = Array.from(nextLayerSet);
  }

  const unplaced = tables.filter((table) => !visited.has(table.name)).map((table) => table.name);
  if (unplaced.length > 0) {
    for (let i = 0; i < unplaced.length; i += 4) {
      layers.push(unplaced.slice(i, i + 4));
    }
  }

  const positions: ERLayoutPositions = {};
  let currentX = 60;

  layers.forEach((layer) => {
    let currentY = 60;
    let maxLayerWidth = DEFAULT_NODE_WIDTH;

    layer.forEach((tableName) => {
      const table = tableMap.get(tableName);
      if (!table) return;

      const isCollapsed = !!collapsedMap[tableName];
      const { width, height } = calculateNodeDimensions(table, detailLevel, isCollapsed);

      positions[tableName] = {
        x: currentX,
        y: currentY,
        width,
        height,
        isCollapsed,
      };

      currentY += height + VERTICAL_SPACING;
      maxLayerWidth = Math.max(maxLayerWidth, width);
    });

    currentX += maxLayerWidth + HORIZONTAL_SPACING;
  });

  return positions;
}

/**
 * Calculates exact SVG socket anchor point for a specific column in a table node.
 */
export function getColumnSocketPosition(
  nodePos: ERNodePosition,
  table: ERTable,
  columnName: string,
  side: 'left' | 'right',
  detailLevel: ERDetailLevel = 'full'
): { x: number; y: number } {
  if (nodePos.isCollapsed) {
    return {
      x: side === 'left' ? nodePos.x : nodePos.x + nodePos.width,
      y: nodePos.y + HEADER_HEIGHT / 2,
    };
  }

  let visibleColumns = table.columns;
  if (detailLevel === 'keys_only') {
    visibleColumns = table.columns.filter((col) => col.isPrimaryKey || col.isForeignKey);
    if (visibleColumns.length === 0) visibleColumns = table.columns.slice(0, 3);
  } else if (detailLevel === 'compact') {
    visibleColumns = table.columns.slice(0, 5);
  }

  const colIndex = visibleColumns.findIndex((col) => col.name.toLowerCase() === columnName.toLowerCase());
  const actualIndex = colIndex !== -1 ? colIndex : 0;

  const y = nodePos.y + HEADER_HEIGHT + actualIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
  const x = side === 'left' ? nodePos.x : nodePos.x + nodePos.width;

  return { x, y };
}

/**
 * Computes smooth Cubic Bezier path between source socket and target socket.
 */
export function computeBezierPath(
  source: { x: number; y: number },
  target: { x: number; y: number }
): string {
  const dx = target.x - source.x;
  const curvature = Math.max(Math.min(Math.abs(dx) * 0.5, 180), 40);

  const cx1 = source.x + (dx >= 0 ? curvature : -curvature);
  const cy1 = source.y;
  const cx2 = target.x - (dx >= 0 ? curvature : -curvature);
  const cy2 = target.y;

  return `M ${source.x} ${source.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${target.x} ${target.y}`;
}

/**
 * Calculates bounding box of all placed table nodes.
 */
export function computeDiagramBounds(positions: ERLayoutPositions): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const values = Object.values(positions);
  if (values.length === 0) {
    return { minX: 0, minY: 0, maxX: 1000, maxY: 800, width: 1000, height: 800 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  values.forEach((pos) => {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  });

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(maxX - minX, 100),
    height: Math.max(maxY - minY, 100),
  };
}
