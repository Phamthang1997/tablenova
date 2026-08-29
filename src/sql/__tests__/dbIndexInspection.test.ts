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

  it('should catch a transposed-letter typo, not just substrings', () => {
    // `nmae` does not contain `name`, nor `name` `nmae` — the substring version misses it.
    expect(dbIndexRegistry.findSimilarColumns('nmae', 'users')).toContain('name');
    expect(dbIndexRegistry.findSimilarColumns('emial', 'users')).toContain('email');
  });

  it('should not suggest anything for a wholly unrelated name', () => {
    expect(dbIndexRegistry.findSimilarColumns('zzzzzzzz', 'users')).toEqual([]);
  });

  it('should find similar table names', () => {
    expect(dbIndexRegistry.findSimilarTables('user')).toContain('users');
    expect(dbIndexRegistry.findSimilarTables('odrers')).toContain('orders');
    expect(dbIndexRegistry.findSimilarTables('zzzzzzzz')).toEqual([]);
  });

  it('should attach quick-fix data pointing at the column only, not the whole alias.column', () => {
    const sql = 'SELECT u.nmae FROM users u;';
    const issue = inspectSqlText(sql).find((i) => i.fix);
    expect(issue?.fix?.candidates).toContain('name');
    // The underline covers `u.nmae`, while the edit range covers only `nmae`.
    expect(sql.slice(issue!.startColumn - 1, issue!.endColumn - 1)).toBe('u.nmae');
    expect(sql.slice(issue!.fix!.startColumn - 1, issue!.fix!.endColumn - 1)).toBe('nmae');
  });

  it('should attach quick-fix data for a mistyped table name', () => {
    const issue = inspectSqlText('SELECT * FROM odrers;').find((i) => i.fix);
    expect(issue?.severity).toBe('error');
    expect(issue?.fix?.candidates).toContain('orders');
  });

  it('should leave fix undefined when nothing is close enough', () => {
    const issues = inspectSqlText('SELECT * FROM zzzzzzzz;');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].fix).toBeUndefined();
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

  it('should not flag a CTE name as a missing table', () => {
    const sql = 'WITH recent AS (SELECT * FROM orders WHERE total > 10) SELECT * FROM recent;';
    expect(inspectSqlText(sql)).toEqual([]);
  });

  it('should not flag any name in a comma-separated CTE list', () => {
    const sql =
      'WITH a AS (SELECT id FROM users), b AS (SELECT id FROM orders) SELECT * FROM a JOIN b ON a.id = b.id;';
    expect(inspectSqlText(sql)).toEqual([]);
  });

  it('should still flag a real unknown table used alongside a CTE', () => {
    const sql = 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent JOIN ghost_table g ON 1=1;';
    const issues = inspectSqlText(sql);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.message.includes('ghost_table'))).toBe(true);
  });

  describe('unqualified columns in the select list', () => {
    const messages = (sql: string) => inspectSqlText(sql).map((i) => i.message);

    it('flags a mistyped bare column and offers the fix', () => {
      const issue = inspectSqlText('SELECT nmae FROM users u;')[0];
      expect(issue.severity).toBe('warning');
      expect(issue.message).toContain('nmae');
      expect(issue.fix?.candidates).toContain('name');
    });

    it('accepts every real column, qualified or not', () => {
      expect(messages('SELECT id, name, u.email FROM users u;')).toEqual([]);
      expect(messages('SELECT DISTINCT name FROM users;')).toEqual([]);
      expect(messages('SELECT * FROM users;')).toEqual([]);
      expect(messages('SELECT u.* FROM users u;')).toEqual([]);
    });

    it('accepts columns coming from any joined table', () => {
      expect(messages('SELECT name, total FROM users JOIN orders ON users.id = orders.user_id;'))
        .toEqual([]);
    });

    // Each case below was a different kind of false positive when one filter was missing.
    it('does not mistake a function call, a keyword or a literal for a column', () => {
      expect(messages('SELECT COUNT(id) FROM users;')).toEqual([]);
      expect(messages('SELECT NULL, TRUE, 42 FROM users;')).toEqual([]);
      expect(messages('SELECT CASE WHEN id > 1 THEN name ELSE email END FROM users;')).toEqual([]);
    });

    it('does not flag an alias being defined', () => {
      expect(messages('SELECT name AS full_name FROM users;')).toEqual([]);
      expect(messages('SELECT COUNT(*) total FROM orders;')).toEqual([]);
      expect(messages('SELECT id, name AS n, email AS e FROM users;')).toEqual([]);
    });

    it('stays silent when the scope is not fully known', () => {
      // An unknown table: it has an error of its own, and its columns cannot be judged.
      expect(messages('SELECT whatever FROM ghost_table;')).toHaveLength(1);
      // A CTE: its columns are not in the catalog.
      expect(messages('WITH c AS (SELECT 1 AS x) SELECT x FROM c;')).toEqual([]);
      // query con in FROM.
      expect(messages('SELECT anything FROM (SELECT id FROM users) t;')).toEqual([]);
    });

    // `users` and `orders` both have an `id` column -> `SELECT id FROM users JOIN orders` is a real
    // error on MySQL/Postgres ("column 'id' is ambiguous"), but perfectly runnable on SQLite.
    describe('ambiguous columns', () => {
      const ambiguous = 'SELECT id FROM users JOIN orders ON users.id = orders.user_id;';

      it('is an error on MySQL and Postgres, with one fix per candidate table', () => {
        for (const dialect of ['mysql', 'pgsql']) {
          const issue = inspectSqlText(ambiguous, dialect)[0];
          expect(issue.severity).toBe('error');
          expect(issue.message).toContain('id');
          expect(issue.fix?.candidates).toEqual(['users.id', 'orders.id']);
        }
      });

      it('stays silent on SQLite and when the dialect is unknown', () => {
        expect(inspectSqlText(ambiguous, 'genericsql')).toEqual([]);
        expect(inspectSqlText(ambiguous)).toEqual([]);
      });

      it('uses the aliases actually written, so the fix compiles', () => {
        const sql = 'SELECT id FROM users u JOIN orders o ON u.id = o.user_id;';
        expect(inspectSqlText(sql, 'mysql')[0].fix?.candidates).toEqual(['u.id', 'o.id']);
      });

      it('treats a self-join as two sources', () => {
        const sql = 'SELECT name FROM users a JOIN users b ON a.id = b.id;';
        expect(inspectSqlText(sql, 'mysql')[0].fix?.candidates).toEqual(['a.name', 'b.name']);
      });

      it('leaves a column owned by only one of the joined tables alone', () => {
        const sql = 'SELECT total, name FROM users JOIN orders ON users.id = orders.user_id;';
        expect(inspectSqlText(sql, 'mysql')).toEqual([]);
      });
    });

    describe('type mismatch in a comparison', () => {
      const msgs = (sql: string) => inspectSqlText(sql, 'mysql').map((i) => i.message);

      it('flags a numeric column compared with non-numeric text', () => {
        expect(msgs("SELECT id FROM users WHERE id = 'abc';")).toHaveLength(1);
        expect(msgs("SELECT total FROM orders o WHERE o.total > 'x';")).toHaveLength(1);
      });

      // Each case below is an ordinary way to write it; a warning here is a false positive.
      it('accepts the coercions every dialect performs', () => {
        expect(msgs("SELECT id FROM users WHERE id = '5';")).toEqual([]);
        expect(msgs("SELECT id FROM users WHERE name = 'abc';")).toEqual([]);
        expect(msgs('SELECT id FROM users WHERE id = 5;')).toEqual([]);
      });

      it('ignores text inside a string or a comment', () => {
        expect(msgs("SELECT id FROM users WHERE name = 'id = ''abc''';")).toEqual([]);
        expect(msgs("SELECT id FROM users -- id = 'abc'\n;")).toEqual([]);
      });

      it('says nothing when the column is ambiguous, since the two types may differ', () => {
        // `id` exists on both users and orders, so which type is being compared is unknown -> no conclusion.
        const sql = "SELECT users.id FROM users JOIN orders ON users.id = orders.user_id WHERE id = 'abc';";
        expect(inspectSqlText(sql, 'mysql')).toEqual([]);
      });
    });

    describe('columns missing from GROUP BY', () => {
      it('is an error on MySQL and Postgres', () => {
        const sql = 'SELECT name, COUNT(*) FROM users GROUP BY email;';
        for (const dialect of ['mysql', 'pgsql']) {
          const issues = inspectSqlText(sql, dialect);
          expect(issues).toHaveLength(1);
          expect(issues[0].severity).toBe('error');
          expect(issues[0].message).toContain('name');
        }
      });

      it('stays silent on SQLite, which returns an arbitrary row instead', () => {
        expect(inspectSqlText('SELECT name, COUNT(*) FROM users GROUP BY email;', 'genericsql'))
          .toEqual([]);
      });

      it('accepts grouped columns and aggregates', () => {
        expect(inspectSqlText('SELECT email, COUNT(*) FROM users GROUP BY email;', 'mysql'))
          .toEqual([]);
        expect(inspectSqlText('SELECT email, MAX(name) FROM users GROUP BY email;', 'mysql'))
          .toEqual([]);
      });

      it('accepts anything when grouping by a primary key', () => {
        // Both Postgres and MySQL allow selecting a column functionally dependent on a grouped primary key.
        expect(inspectSqlText('SELECT id, name, email FROM users GROUP BY id;', 'pgsql'))
          .toEqual([]);
      });

      it('does not judge GROUP BY by ordinal, where names cannot be matched', () => {
        expect(inspectSqlText('SELECT name, COUNT(*) FROM users GROUP BY 1;', 'mysql')).toEqual([]);
      });
    });

    it('scopes each statement separately', () => {
      // `total` is a column of orders, not of users -> only the second statement is valid.
      const msgs = messages('SELECT total FROM users;\nSELECT total FROM orders;');
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('total');
    });
  });

  it('should propagate table rename across SQL script while skipping strings and comments', () => {
    const sql = "SELECT * FROM users u WHERE u.name = 'users' -- users comment\nJOIN orders o ON u.id = o.user_id;";
    const renamed = propagateTableRenameInText(sql, 'users', 'app_users');
    expect(renamed).toContain('FROM app_users u');
    expect(renamed).toContain("u.name = 'users'"); // string string literal unchanged
    expect(renamed).toContain('-- users comment'); // comment unchanged
  });
});
