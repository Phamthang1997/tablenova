/**
 * Type definitions for Interactive ER Diagram.
 * Defines schemas for nodes, edges, relationships, layout coordinates, and export formats.
 */

export interface ERColumn {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  refTable?: string;
  refColumn?: string;
  nullable?: boolean;
  comment?: string;
}

export interface ERTable {
  id: string; // Typically tableName
  name: string;
  schema?: string;
  kind?: 'table' | 'view';
  columns: ERColumn[];
  rowCount?: number | null;
  comment?: string;
}

export interface ERRelationship {
  id: string; // e.g. "payment.customer_id->customer.customer_id"
  name?: string; // Constraint name e.g. "fk_payment_customer"
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  cardinality?: '1:1' | '1:N' | 'N:M';
}

export interface ERNodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  isCollapsed?: boolean;
}

export type ERLayoutPositions = Record<string, ERNodePosition>;

export interface ERViewport {
  x: number;
  y: number;
  zoom: number;
}

export type ERDetailLevel = 'full' | 'keys_only' | 'compact';

export interface ERDisplayConfig {
  detailLevel: ERDetailLevel;
  showViews: boolean;
  showIsolatedTables: boolean;
  showMinimap: boolean;
  highlightedTable: string | null;
  highlightedRelation: string | null;
  selectedTableIds: Set<string>;
  searchQuery: string;
}

export type ERExportFormat = 'png' | 'clipboard' | 'svg' | 'mermaid' | 'dbml' | 'sql';
