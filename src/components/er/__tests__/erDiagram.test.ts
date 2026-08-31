import { describe, it, expect } from 'vitest';
import {
  computeAutoLayout,
  calculateNodeDimensions,
  getColumnSocketPosition,
  computeBezierPath,
  computeDiagramBounds,
} from '../erLayoutEngine';
import { exportToMermaid, exportToDbml, exportToSql, generateFullDiagramSvg } from '../erExportHelper';
import type { ERTable, ERRelationship } from '../erTypes';

const mockTables: ERTable[] = [
  {
    id: 'customer',
    name: 'customer',
    columns: [
      { name: 'customer_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'store_id', type: 'int', isPrimaryKey: false, isForeignKey: true, refTable: 'store', refColumn: 'store_id' },
      { name: 'first_name', type: 'varchar(45)', isPrimaryKey: false, isForeignKey: false },
      { name: 'email', type: 'varchar(50)', isPrimaryKey: false, isForeignKey: false, nullable: true },
    ],
  },
  {
    id: 'payment',
    name: 'payment',
    columns: [
      { name: 'payment_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'customer_id', type: 'int', isPrimaryKey: false, isForeignKey: true, refTable: 'customer', refColumn: 'customer_id' },
      { name: 'amount', type: 'decimal(5,2)', isPrimaryKey: false, isForeignKey: false },
    ],
  },
  {
    id: 'store',
    name: 'store',
    columns: [
      { name: 'store_id', type: 'int', isPrimaryKey: true, isForeignKey: false },
      { name: 'manager_staff_id', type: 'int', isPrimaryKey: false, isForeignKey: false },
    ],
  },
  {
    id: 'isolated_log',
    name: 'isolated_log',
    columns: [
      { name: 'log_id', type: 'bigint', isPrimaryKey: true, isForeignKey: false },
      { name: 'message', type: 'text', isPrimaryKey: false, isForeignKey: false },
    ],
  },
];

const mockRelationships: ERRelationship[] = [
  {
    id: 'payment.customer_id->customer.customer_id',
    name: 'fk_payment_customer',
    sourceTable: 'payment',
    sourceColumn: 'customer_id',
    targetTable: 'customer',
    targetColumn: 'customer_id',
  },
  {
    id: 'customer.store_id->store.store_id',
    name: 'fk_customer_store',
    sourceTable: 'customer',
    sourceColumn: 'store_id',
    targetTable: 'store',
    targetColumn: 'store_id',
  },
];

describe('erLayoutEngine', () => {
  it('calculates correct node dimensions for different detail levels', () => {
    const fullDim = calculateNodeDimensions(mockTables[0], 'full', false);
    expect(fullDim.width).toBe(260);
    expect(fullDim.height).toBe(38 + 4 * 24 + 6);

    const keysOnlyDim = calculateNodeDimensions(mockTables[0], 'keys_only', false);
    expect(keysOnlyDim.height).toBe(38 + 2 * 24 + 6);

    const collapsedDim = calculateNodeDimensions(mockTables[0], 'full', true);
    expect(collapsedDim.height).toBe(38);
  });

  it('computes hierarchical auto-layout without overlap', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');

    expect(layout['store']).toBeDefined();
    expect(layout['customer']).toBeDefined();
    expect(layout['payment']).toBeDefined();
    expect(layout['isolated_log']).toBeDefined();

    expect(layout['store'].x).toBeLessThan(layout['customer'].x);
    expect(layout['customer'].x).toBeLessThan(layout['payment'].x);
  });

  it('computes correct column socket positions', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const socket = getColumnSocketPosition(
      layout['customer'],
      mockTables[0],
      'store_id',
      'right',
      'full'
    );

    expect(socket.x).toBe(layout['customer'].x + layout['customer'].width);
    expect(socket.y).toBe(layout['customer'].y + 74);
  });

  it('computes valid Cubic Bezier SVG path', () => {
    const path = computeBezierPath({ x: 100, y: 150 }, { x: 400, y: 250 });
    expect(path).toMatch(/^M 100 150 C \d+ \d+, \d+ \d+, 400 250$/);
  });

  it('calculates bounding box of diagram correctly', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const bounds = computeDiagramBounds(layout);

    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.minX).toBe(60);
  });
});

describe('erExportHelper', () => {
  it('exports valid Mermaid ER diagram syntax', () => {
    const mermaid = exportToMermaid(mockTables, mockRelationships);
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('store ||--o{ customer : "fk_customer_store"');
    expect(mermaid).toContain('customer ||--o{ payment : "fk_payment_customer"');
    expect(mermaid).toContain('customer {');
    expect(mermaid).toContain('int customer_id PK');
    expect(mermaid).toContain('int store_id FK');
  });

  it('exports valid DBML format', () => {
    const dbml = exportToDbml(mockTables, mockRelationships);
    expect(dbml).toContain('Table customer {');
    expect(dbml).toContain('customer_id int [pk]');
    expect(dbml).toContain('Ref: payment.customer_id > customer.customer_id');
    expect(dbml).toContain('Ref: customer.store_id > store.store_id');
  });

  it('exports valid DDL SQL with foreign key constraints', () => {
    const sql = exportToSql(mockTables, mockRelationships);
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `customer`');
    expect(sql).toContain('PRIMARY KEY (`customer_id`)');
    expect(sql).toContain('ALTER TABLE `payment` ADD CONSTRAINT `fk_payment_customer` FOREIGN KEY (`customer_id`) REFERENCES `customer` (`customer_id`);');
  });

  it('generates complete standalone SVG diagram with tables and relationship paths', () => {
    const layout = computeAutoLayout(mockTables, mockRelationships, 'full');
    const { svgString, width, height } = generateFullDiagramSvg(mockTables, mockRelationships, layout, 'full', 'dark');

    expect(width).toBeGreaterThan(500);
    expect(height).toBeGreaterThan(300);
    expect(svgString).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svgString).toContain('customer');
    expect(svgString).toContain('payment');
    expect(svgString).toContain('store');
    expect(svgString).toContain('customer_id');
    expect(svgString).toContain('marker id="er-export-arrow"');
    expect(svgString).toContain('<path d="M');
  });

  it('handles empty tables for SVG generation gracefully', () => {
    const { svgString, width, height } = generateFullDiagramSvg([], [], {}, 'full', 'dark');
    expect(width).toBe(600);
    expect(height).toBe(400);
    expect(svgString).toContain('No tables to display');
  });
});
