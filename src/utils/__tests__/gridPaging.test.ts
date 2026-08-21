import { describe, it, expect } from 'vitest';
import { countKey, nextCountMode, seekColumn, seekViewKey } from '../gridPaging';

describe('countKey', () => {
  it('is stable for the same state', () => {
    expect(countKey('users', '', 0)).toBe(countKey('users', '', 0));
  });

  it('changes with the table, the filter and the data version', () => {
    const base = countKey('users', 'id > 1', 3);
    expect(countKey('orders', 'id > 1', 3)).not.toBe(base);
    expect(countKey('users', 'id > 2', 3)).not.toBe(base);
    expect(countKey('users', 'id > 1', 4)).not.toBe(base);
  });

  it('cannot be forged from the filter text', () => {
    // A separator-joined key would collapse these two: the filter is arbitrary user SQL, so
    // whatever delimiter it used would also be a delimiter the user can type.
    expect(countKey('a', 'b', 1)).not.toBe(countKey('a', '', 1));
    expect(countKey('a|b', '', 1)).not.toBe(countKey('a', 'b', 1));
    expect(countKey('a', '","', 1)).not.toBe(countKey('a', '', 1));
  });
});

describe('nextCountMode', () => {
  it('counts on the first read of a table', () => {
    expect(nextCountMode(null, countKey('users', '', 0))).toBe('auto');
  });

  it('skips while the counted thing is unchanged — page, sort and page size all land here', () => {
    const key = countKey('users', '', 0);
    expect(nextCountMode(key, key)).toBe('skip');
  });

  it('counts again when the filter or the data changed', () => {
    const before = countKey('users', '', 0);
    expect(nextCountMode(before, countKey('users', 'id > 1', 0))).toBe('auto');
    expect(nextCountMode(before, countKey('users', '', 1))).toBe('auto');
  });

  it('honours an explicit request for the exact number, even mid-page', () => {
    const key = countKey('users', '', 0);
    expect(nextCountMode(key, key, true)).toBe('exact');
    expect(nextCountMode(null, key, true)).toBe('exact');
  });
});

describe('seekColumn', () => {
  it('seeks on a single-column primary key when nothing else is sorted', () => {
    expect(seekColumn(['id'], undefined)).toBe('id');
  });

  it('seeks on the key when the sort IS the key, in either direction', () => {
    // Direction is the backend's business: it flips `>` to `<`.
    expect(seekColumn(['id'], 'id')).toBe('id');
  });

  it('refuses a sort on any other column — that order has no unique boundary', () => {
    expect(seekColumn(['id'], 'created_at')).toBeNull();
  });

  it('refuses a composite key and a table with no key at all', () => {
    expect(seekColumn(['film_id', 'actor_id'], undefined)).toBeNull();
    expect(seekColumn([], undefined)).toBeNull();
    expect(seekColumn([''], undefined)).toBeNull();
  });

  it('refuses a filtered view — the imposed ORDER BY would cost more than the OFFSET it replaces', () => {
    expect(seekColumn(['id'], undefined, "name LIKE '%a%'")).toBeNull();
    expect(seekColumn(['id'], 'id', "name LIKE '%a%'")).toBeNull();
    // An empty / whitespace filter is no filter.
    expect(seekColumn(['id'], undefined, '')).toBe('id');
    expect(seekColumn(['id'], undefined, '   ')).toBe('id');
  });
});

describe('seekViewKey', () => {
  it('changes with everything that moves the boundaries', () => {
    const base = seekViewKey('users', '', undefined, 'asc', 50);
    expect(seekViewKey('orders', '', undefined, 'asc', 50)).not.toBe(base);
    expect(seekViewKey('users', 'id > 1', undefined, 'asc', 50)).not.toBe(base);
    expect(seekViewKey('users', '', 'name', 'asc', 50)).not.toBe(base);
    expect(seekViewKey('users', '', undefined, 'desc', 50)).not.toBe(base);
    expect(seekViewKey('users', '', undefined, 'asc', 100)).not.toBe(base);
  });

  it('is stable for the same sequence, so a saved page keeps its cursors', () => {
    expect(seekViewKey('users', 'a = 1', 'id', 'desc', 200))
      .toBe(seekViewKey('users', 'a = 1', 'id', 'desc', 200));
  });
});
