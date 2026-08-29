import { describe, expect, it } from 'vitest';
import { commandAtLine, commandNameOf, splitRedisCommands } from '../redisScript';

describe('splitRedisCommands', () => {
  it('mỗi dòng là một lệnh', () => {
    expect(splitRedisCommands('PING\nDBSIZE')).toEqual([
      { text: 'PING', line: 1 },
      { text: 'DBSIZE', line: 2 },
    ]);
  });

  it('bỏ dòng trống và dòng chú thích, nhưng GIỮ số dòng thật', () => {
    // Line numbers map directly to buffer positions for cursor navigation and error marking.
    
    const cmds = splitRedisCommands('# đếm key\n\nDBSIZE\n\n# xong\nPING');
    expect(cmds).toEqual([
      { text: 'DBSIZE', line: 3 },
      { text: 'PING', line: 6 },
    ]);
  });

  it('cắt khoảng trắng hai đầu', () => {
    expect(splitRedisCommands('   GET  a   ')).toEqual([{ text: 'GET  a', line: 1 }]);
  });

  it('CRLF', () => {
    expect(splitRedisCommands('PING\r\nDBSIZE')).toEqual([
      { text: 'PING', line: 1 },
      { text: 'DBSIZE', line: 2 },
    ]);
  });

  it('buffer rỗng hoặc toàn chú thích thì không có lệnh nào', () => {
    expect(splitRedisCommands('')).toEqual([]);
    expect(splitRedisCommands('# chỉ có chú thích\n\n')).toEqual([]);
  });

  it('`#` giữa dòng KHÔNG phải chú thích', () => {
    // Only lines starting with `#` are comments. `#` inside values (`SET k a#b`) is preserved.
    
    expect(splitRedisCommands('SET k a#b')).toEqual([{ text: 'SET k a#b', line: 1 }]);
  });
});

describe('commandAtLine', () => {
  const buf = 'PING\n\n# ghi chú\nDBSIZE\n';

  it('con trỏ ngay trên một lệnh', () => {
    expect(commandAtLine(buf, 1)?.text).toBe('PING');
    expect(commandAtLine(buf, 4)?.text).toBe('DBSIZE');
  });

  it('con trỏ ở dòng trống hoặc chú thích thì lùi lên lệnh gần nhất phía trên', () => {
    expect(commandAtLine(buf, 2)?.text).toBe('PING');
    expect(commandAtLine(buf, 3)?.text).toBe('PING');
  });

  it('con trỏ dưới lệnh cuối vẫn trả về lệnh cuối', () => {
    // Handles trailing newline gracefully without treating it as empty input.
    expect(commandAtLine(buf, 99)?.text).toBe('DBSIZE');
  });

  it('con trỏ phía trên mọi lệnh thì không có gì để chạy', () => {
    expect(commandAtLine('\n\nPING', 1)).toBeNull();
  });

  it('buffer không có lệnh nào', () => {
    expect(commandAtLine('# rỗng', 1)).toBeNull();
  });
});

describe('commandNameOf', () => {
  const known = ['CONFIG GET', 'CLIENT LIST', 'XINFO STREAM'];

  it('lệnh một từ', () => {
    expect(commandNameOf('get mykey', known)).toBe('GET');
  });

  it('lệnh hai từ khi bảng lệnh biết nó', () => {
    expect(commandNameOf('config get maxmemory', known)).toBe('CONFIG GET');
    expect(commandNameOf('XINFO stream s', known)).toBe('XINFO STREAM');
  });

  it('không gộp hai từ khi từ thứ hai chỉ là tham số', () => {
    // Preserves identifier casing (`GET key` does not uppercase argument to `GET KEY`).
    
    expect(commandNameOf('GET list', known)).toBe('GET');
  });

  it('chuỗi rỗng', () => {
    expect(commandNameOf('   ', known)).toBe('');
  });
});
