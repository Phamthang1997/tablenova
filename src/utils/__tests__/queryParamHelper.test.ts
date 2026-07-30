import { describe, it, expect } from 'vitest';
import {
  extractQueryParams,
  maskCommentsAndStrings,
  resolveParamValue,
  buildParameterizedSql,
  substituteQueryParams
} from '@/utils/queryParamHelper';

describe('queryParamHelper', () => {
  describe('maskCommentsAndStrings', () => {
    it('should replace single-line comments with spaces', () => {
      const sql = 'SELECT * FROM users -- WHERE id = :user_id';
      const masked = maskCommentsAndStrings(sql);
      expect(masked).toBe('SELECT * FROM users                       ');
      expect(masked.length).toBe(sql.length);
    });

    it('should replace block comments with spaces', () => {
      const sql = 'SELECT /* comment with :user_id */ * FROM users';
      const masked = maskCommentsAndStrings(sql);
      expect(masked).toBe('SELECT                             * FROM users');
      expect(masked.length).toBe(sql.length);
    });

    it('should replace single/double quoted strings with spaces', () => {
      const sql = "SELECT ':user_id', \":org_id\" FROM users";
      const masked = maskCommentsAndStrings(sql);
      expect(masked.length).toBe(sql.length);
      expect(masked).toBe('SELECT           ,           FROM users');
    });
  });

  describe('extractQueryParams', () => {
    it('should extract colon parameters (:name)', () => {
      const sql = 'SELECT * FROM users WHERE id = :user_id AND org = :org_id';
      const params = extractQueryParams(sql, 0);
      expect(params).toEqual([':user_id', ':org_id']);
    });

    it('should extract percent parameters (%name%)', () => {
      const sql = 'SELECT * FROM users WHERE id = %user_id% AND org = %org.id%';
      const params = extractQueryParams(sql, 1);
      expect(params).toEqual(['%user_id%', '%org.id%']);
    });

    it('should extract positional parameters (?)', () => {
      const sql = 'SELECT * FROM users WHERE id = ? AND status = ?';
      const params = extractQueryParams(sql, 2);
      expect(params).toEqual(['Tham số ? #1', 'Tham số ? #2']);
    });

    it('should extract dollar template parameters (${name})', () => {
      const sql = 'SELECT * FROM users WHERE id = ${user_id} AND org = ${org.id}';
      const params = extractQueryParams(sql, 3);
      expect(params).toEqual(['${user_id}', '${org.id}']);
    });

    it('should ignore parameters inside comments or string literals', () => {
      const sql = "SELECT ':ignored' FROM users WHERE id = :real_id -- AND org = :commented";
      const params = extractQueryParams(sql, 0);
      expect(params).toEqual([':real_id']);
    });
  });

  describe('resolveParamValue', () => {
    it('should resolve null type', () => {
      expect(resolveParamValue('anything', 'null')).toBeNull();
    });

    it('should resolve text type', () => {
      expect(resolveParamValue('123', 'text')).toBe('123');
    });

    it('should resolve boolean type', () => {
      expect(resolveParamValue('true', 'boolean')).toBe(true);
      expect(resolveParamValue('1', 'boolean')).toBe(true);
      expect(resolveParamValue('false', 'boolean')).toBe(false);
      expect(resolveParamValue('0', 'boolean')).toBe(false);
    });

    it('should resolve number type', () => {
      expect(resolveParamValue('123', 'number')).toBe(123);
      expect(resolveParamValue('45.67', 'number')).toBe(45.67);
      expect(resolveParamValue('invalid', 'number')).toBe('invalid');
    });

    it('should auto resolve values appropriately', () => {
      expect(resolveParamValue('', 'auto')).toBeNull();
      expect(resolveParamValue('true', 'auto')).toBe(true);
      expect(resolveParamValue('false', 'auto')).toBe(false);
      expect(resolveParamValue('123', 'auto')).toBe(123);
      expect(resolveParamValue('01234', 'auto')).toBe('01234'); // Keep leading zeros
      expect(resolveParamValue('3.14', 'auto')).toBe(3.14);
      expect(resolveParamValue('hello', 'auto')).toBe('hello');
    });
  });

  describe('buildParameterizedSql', () => {
    it('should build parameterized SQL for PostgreSQL ($1, $2)', () => {
      const sql = 'SELECT * FROM users WHERE id = :user_id AND status = :status';
      const valuesMap = {
        ':user_id': { value: '42', type: 'number' as const },
        ':status': { value: 'active', type: 'text' as const }
      };
      const result = buildParameterizedSql(sql, 0, valuesMap, 'postgres');
      expect(result.sql).toBe('SELECT * FROM users WHERE id = $1 AND status = $2');
      expect(result.values).toEqual([42, 'active']);
    });

    it('should build parameterized SQL for SQLite/MySQL (?)', () => {
      const sql = 'SELECT * FROM users WHERE id = :user_id AND status = :status';
      const valuesMap = {
        ':user_id': { value: '42', type: 'number' as const },
        ':status': { value: 'active', type: 'text' as const }
      };
      const result = buildParameterizedSql(sql, 0, valuesMap, 'sqlite');
      expect(result.sql).toBe('SELECT * FROM users WHERE id = ? AND status = ?');
      expect(result.values).toEqual([42, 'active']);
    });
  });

  describe('substituteQueryParams', () => {
    it('should replace parameters directly into SQL string', () => {
      const sql = 'SELECT * FROM users WHERE id = :user_id';
      const valuesMap = { ':user_id': '42' };
      const substituted = substituteQueryParams(sql, 0, valuesMap);
      expect(substituted).toBe('SELECT * FROM users WHERE id = 42');
    });
  });
});
