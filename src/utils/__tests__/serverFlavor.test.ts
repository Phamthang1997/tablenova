import { describe, it, expect } from 'vitest';
import { isMariaDbVersion } from '../serverFlavor';

describe('isMariaDbVersion', () => {
  it('detects MariaDB from the modern VERSION() string', () => {
    expect(isMariaDbVersion('10.11.6-MariaDB-1:10.11.6+maria~ubu2204')).toBe(true);
    expect(isMariaDbVersion('11.4.2-MariaDB')).toBe(true);
  });

  // Older servers prefix a fake 5.5.5 so pre-10.x clients do not choke on the real number.
  it('detects MariaDB behind the 5.5.5 compatibility prefix', () => {
    expect(isMariaDbVersion('5.5.5-10.4.32-MariaDB')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMariaDbVersion('10.6.18-mariadb-log')).toBe(true);
    expect(isMariaDbVersion('10.6.18-MARIADB')).toBe(true);
  });

  it('does not match MySQL', () => {
    expect(isMariaDbVersion('8.0.35')).toBe(false);
    expect(isMariaDbVersion('8.4.3-0ubuntu0.24.04.1')).toBe(false);
    expect(isMariaDbVersion('5.7.44-log')).toBe(false);
  });

  // The caller passes whatever the query returned, so absent/empty must read as "not MariaDB"
  // rather than throw: the gate then hides the feature instead of showing a broken panel.
  it('treats missing or empty input as not MariaDB', () => {
    expect(isMariaDbVersion(undefined)).toBe(false);
    expect(isMariaDbVersion(null)).toBe(false);
    expect(isMariaDbVersion('')).toBe(false);
  });
});
