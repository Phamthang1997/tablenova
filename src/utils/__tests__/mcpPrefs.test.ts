import { describe, it, expect } from 'vitest';
import { parsePort } from '../mcpPrefs';

describe('parsePort', () => {
  it('accepts a real port', () => {
    expect(parsePort('45124')).toBe(45124);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  // Every one of these used to be able to reach `bind()`, where the failure surfaces either as
  // "port already in use" or as a listener on a port nobody chose.
  it('falls back rather than passing anything unusable down', () => {
    for (const bad of [null, '', '0', '-1', '65536', '99999', 'default', '45124.5', 'NaN', ' ']) {
      expect(parsePort(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
