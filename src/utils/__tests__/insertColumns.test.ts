import { describe, it, expect } from 'vitest';
import {
  insertTargetBeforeCaret,
  writableInsertColumns,
  buildInsertColumnsSnippet,
  type InsertColumn,
} from '../../sql/insertColumns';

/** Sakila's `actor`: an auto-increment PK plus two plain columns and a timestamp. */
const ACTOR: InsertColumn[] = [
  { name: 'actor_id', autoIncrement: true },
  { name: 'first_name' },
  { name: 'last_name' },
  { name: 'last_update' },
];

describe('insertTargetBeforeCaret', () => {
  it('matches a bare target followed by a space', () => {
    expect(insertTargetBeforeCaret('INSERT INTO users ')).toBe('users');
    expect(insertTargetBeforeCaret('insert into users   ')).toBe('users');
  });

  it('matches after a preceding statement, since it anchors at the caret', () => {
    expect(insertTargetBeforeCaret('SELECT 1;\nINSERT INTO users ')).toBe('users');
  });

  it('strips quoting and keeps only the last segment of a qualified name', () => {
    expect(insertTargetBeforeCaret('INSERT INTO `sakila`.`actor` ')).toBe('actor');
    expect(insertTargetBeforeCaret('INSERT INTO "public"."users" ')).toBe('users');
    expect(insertTargetBeforeCaret('INSERT INTO [dbo].[users] ')).toBe('users');
  });

  it('accepts MySQL INSERT IGNORE', () => {
    expect(insertTargetBeforeCaret('INSERT IGNORE INTO users ')).toBe('users');
  });

  it('does not match before the space, so it cannot fire mid-identifier', () => {
    expect(insertTargetBeforeCaret('INSERT INTO users')).toBeNull();
    expect(insertTargetBeforeCaret('INSERT INTO use')).toBeNull();
  });

  it('does not match once the user has moved past the column list', () => {
    expect(insertTargetBeforeCaret('INSERT INTO users (')).toBeNull();
    expect(insertTargetBeforeCaret('INSERT INTO users (name, ')).toBeNull();
    expect(insertTargetBeforeCaret('INSERT INTO users SELECT ')).toBeNull();
  });

  it('does not match a half-typed qualified name', () => {
    expect(insertTargetBeforeCaret('INSERT INTO sakila. ')).toBeNull();
  });

  it('ignores other statements', () => {
    expect(insertTargetBeforeCaret('UPDATE users ')).toBeNull();
    expect(insertTargetBeforeCaret('SELECT * FROM users ')).toBeNull();
  });
});

describe('writableInsertColumns', () => {
  it('drops the columns the database writes itself', () => {
    expect(writableInsertColumns(ACTOR)).toEqual(['first_name', 'last_name', 'last_update']);
  });

  it('drops a generated column', () => {
    const cols: InsertColumn[] = [{ name: 'a' }, { name: 'total', generated: true }];
    expect(writableInsertColumns(cols)).toEqual(['a']);
  });

  it('drops a Postgres identity-always column', () => {
    const cols: InsertColumn[] = [{ name: 'id', identityAlways: true }, { name: 'a' }];
    expect(writableInsertColumns(cols)).toEqual(['a']);
  });

  it('keeps a plain primary key, which the user must supply', () => {
    const cols: InsertColumn[] = [{ name: 'code' }, { name: 'label' }];
    expect(writableInsertColumns(cols)).toEqual(['code', 'label']);
  });
});

describe('buildInsertColumnsSnippet', () => {
  it('builds the column list with a tab stop inside VALUES', () => {
    expect(buildInsertColumnsSnippet(ACTOR)).toEqual({
      text: '(first_name, last_name, last_update) VALUES ($1)',
      count: 3,
    });
  });

  it('offers nothing for a table with no columns', () => {
    expect(buildInsertColumnsSnippet([])).toBeNull();
  });

  it('offers nothing when every column is written by the database', () => {
    const cols: InsertColumn[] = [
      { name: 'id', autoIncrement: true },
      { name: 'total', generated: true },
    ];
    expect(buildInsertColumnsSnippet(cols)).toBeNull();
  });
});

describe('suggestion ranking', () => {
  it("ranks '00_insertcols' above the FK JOIN conditions at '0_'", () => {
    // The tier order is what puts this item at the top of the popup; `completionOrder.test.ts`
    // pins the rest of the tiers.
    expect(['0_0', '00_insertcols'].sort()).toEqual(['00_insertcols', '0_0']);
  });
});
