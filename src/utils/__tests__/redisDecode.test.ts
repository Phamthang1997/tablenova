import { describe, it, expect } from 'vitest';
import { phpUnserialize, decodeRedisValue } from '../redisDecode';

describe('redisDecode', () => {
  describe('phpUnserialize', () => {
    it('should unserialize null (N;)', () => {
      const bytes = new TextEncoder().encode('N;');
      expect(phpUnserialize(bytes)).toBeNull();
    });

    it('should unserialize boolean (b:1; / b:0;)', () => {
      const bTrue = new TextEncoder().encode('b:1;');
      const bFalse = new TextEncoder().encode('b:0;');
      expect(phpUnserialize(bTrue)).toBe(true);
      expect(phpUnserialize(bFalse)).toBe(false);
    });

    it('should unserialize integer (i:123;)', () => {
      const bytes = new TextEncoder().encode('i:123;');
      expect(phpUnserialize(bytes)).toBe(123);
    });

    it('should unserialize float (d:45.67;)', () => {
      const bytes = new TextEncoder().encode('d:45.67;');
      expect(phpUnserialize(bytes)).toBe(45.67);
    });

    it('should unserialize string (s:5:"hello";)', () => {
      const bytes = new TextEncoder().encode('s:5:"hello";');
      expect(phpUnserialize(bytes)).toBe('hello');
    });

    it('should unserialize indexed array (a:2:{i:0;s:3:"foo";i:1;s:3:"bar";})', () => {
      const bytes = new TextEncoder().encode('a:2:{i:0;s:3:"foo";i:1;s:3:"bar";}');
      expect(phpUnserialize(bytes)).toEqual(['foo', 'bar']);
    });

    it('should unserialize associative array', () => {
      const bytes = new TextEncoder().encode('a:2:{s:3:"key";s:5:"value";s:4:"page";i:1;}');
      expect(phpUnserialize(bytes)).toEqual({ key: 'value', page: 1 });
    });

    it('should unserialize serialized object', () => {
      const bytes = new TextEncoder().encode('O:4:"User":1:{s:4:"name";s:4:"John";}');
      expect(phpUnserialize(bytes)).toEqual({ __class: 'User', name: 'John' });
    });
  });

  describe('decodeRedisValue', () => {
    it('should decode JSON strings', async () => {
      const input = new TextEncoder().encode('{"name":"Alice","age":30}');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('json');
      expect(JSON.parse(result.text)).toEqual({ name: 'Alice', age: 30 });
    });

    it('should decode PHP serialized strings', async () => {
      const input = new TextEncoder().encode('a:1:{s:4:"role";s:5:"admin";}');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('php-serialize');
      expect(JSON.parse(result.text)).toEqual({ role: 'admin' });
    });

    it('should fallback to raw text for plain text', async () => {
      const input = new TextEncoder().encode('plain text value');
      const result = await decodeRedisValue(input);
      expect(result.ok).toBe(true);
      expect(result.format).toBe('raw');
      expect(result.text).toBe('plain text value');
    });
  });
});
