import { describe, it, expect } from 'vitest';
import { splitType, joinType, typeBase } from '../columnType';

describe('splitType', () => {
  it('splits a plain length', () => {
    expect(splitType('varchar(255)')).toEqual({ head: 'varchar', args: '255', tail: '' });
  });

  it('splits precision and scale', () => {
    expect(splitType('decimal(10,2)')).toEqual({ head: 'decimal', args: '10,2', tail: '' });
  });

  it('keeps MySQL modifiers that follow the paren', () => {
    expect(splitType('int(10) unsigned')).toEqual({ head: 'int', args: '10', tail: 'unsigned' });
    expect(splitType('int(10) unsigned zerofill')).toEqual({ head: 'int', args: '10', tail: 'unsigned zerofill' });
  });

  it('handles a multi-word type name', () => {
    expect(splitType('character varying(45)')).toEqual({ head: 'character varying', args: '45', tail: '' });
  });

  it('handles a type with no paren at all', () => {
    expect(splitType('timestamp without time zone')).toEqual({ head: 'timestamp without time zone', args: '', tail: '' });
    expect(splitType('text')).toEqual({ head: 'text', args: '', tail: '' });
  });

  it('keeps an inner paren inside the args', () => {
    expect(splitType("enum('a(1)','b')")).toEqual({ head: 'enum', args: "'a(1)','b'", tail: '' });
  });

  it('tolerates whitespace and empty input', () => {
    expect(splitType('  int (11) ')).toEqual({ head: 'int', args: '11', tail: '' });
    expect(splitType('')).toEqual({ head: '', args: '', tail: '' });
    expect(splitType(null)).toEqual({ head: '', args: '', tail: '' });
  });

  it('does not lose an unclosed paren', () => {
    expect(splitType('varchar(255')).toEqual({ head: 'varchar(255', args: '', tail: '' });
  });
});

describe('joinType', () => {
  it('puts the args back where the paren was, not at the end', () => {
    expect(joinType('int', '10', 'unsigned')).toBe('int(10) unsigned');
  });

  it('omits the paren when there are no args', () => {
    expect(joinType('text', '', '')).toBe('text');
    expect(joinType('int', '', 'unsigned')).toBe('int unsigned');
  });
});

describe('round trip', () => {
  const cases = [
    'varchar(255)',
    'decimal(10,2)',
    'int(10) unsigned',
    'character varying(45)',
    'timestamp without time zone',
    'text',
    "enum('M','F')",
  ];

  it.each(cases)('%s survives split -> join', raw => {
    const { head, args, tail } = splitType(raw);
    expect(joinType(head, args, tail)).toBe(raw);
  });
});

describe('typeBase', () => {
  it('drops the length but keeps the modifiers', () => {
    expect(typeBase('varchar(255)')).toBe('varchar');
    expect(typeBase('int(10) unsigned')).toBe('int unsigned');
    expect(typeBase('timestamp without time zone')).toBe('timestamp without time zone');
  });
});
