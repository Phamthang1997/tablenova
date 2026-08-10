import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dbIndexRegistry } from '../dbIndexRegistry';
import { inspectSqlText } from '../inspection';
import { propagateTableRenameInText } from '../refactor';

// Mock dbHelper.getFullCatalog for unit testing
vi.mock('../../utils/dbHelper', () => ({
  dbHelper: {
    getFullCatalog: async () => ({
      columns: {
        users: [
          { name: 'id', type: 'INT', isPrimaryKey: true },
          { name: 'name', type: 'VARCHAR' },
          { name: 'email', type: 'VARCHAR' },
        ],
        orders: [
          { name: 'id', type: 'INT', isPrimaryKey: true },
          { name: 'user_id', type: 'INT' },
          { name: 'total', type: 'DECIMAL' },
        ],
      },
      foreignKeys: {
        orders: [{ column: 'user_id', foreignTable: 'users', foreignColumn: 'id' }],
      },
    }),
  },
}));

describe('DbIndexRegistry & SQL Inspection Tests', () => {
  beforeEach(async () => {
    dbIndexRegistry.invalidate();
    await dbIndexRegistry.buildIndex();
  });

  it('should build index and perform O(1) table and column lookups', () => {
    expect(dbIndexRegistry.isReady()).toBe(true);
    expect(dbIndexRegistry.hasTable('users')).toBe(true);
    expect(dbIndexRegistry.hasTable('ORDERS')).toBe(true);
    expect(dbIndexRegistry.hasTable('non_existent')).toBe(false);

    expect(dbIndexRegistry.hasColumn('users', 'email')).toBe(true);
    expect(dbIndexRegistry.hasColumn('users', 'INVALID_COL')).toBe(false);
    expect(dbIndexRegistry.getColumn('users', 'id')?.isPrimaryKey).toBe(true);
  });

  it('should find similar columns for suggestions', () => {
    const suggestions = dbIndexRegistry.findSimilarColumns('emai', 'users');
    expect(suggestions).toContain('email');
  });

  it('should inspect valid SQL text with zero issues', () => {
    const sql = 'SELECT u.id, u.name, u.email FROM users u WHERE u.id = 1;';
    const issues = inspectSqlText(sql);
    expect(issues.length).toBe(0);
  });

  it('should detect unresolved table and create Error diagnostic issue', () => {
    const sql = 'SELECT * FROM unknown_table_xyz;';
    const issues = inspectSqlText(sql);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('unknown_table_xyz');
  });

  it('should detect unresolved column and create Warning diagnostic issue', () => {
    const sql = 'SELECT u.non_existent_column FROM users u;';
    const issues = inspectSqlText(sql);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('non_existent_column');
  });

  it('should propagate table rename across SQL script while skipping strings and comments', () => {
    const sql = "SELECT * FROM users u WHERE u.name = 'users' -- users comment\nJOIN orders o ON u.id = o.user_id;";
    const renamed = propagateTableRenameInText(sql, 'users', 'app_users');
    expect(renamed).toContain('FROM app_users u');
    expect(renamed).toContain("u.name = 'users'"); // string string literal unchanged
    expect(renamed).toContain('-- users comment'); // comment unchanged
  });
});
