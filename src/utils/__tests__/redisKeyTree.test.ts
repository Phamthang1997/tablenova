import { describe, it, expect } from 'vitest';
import { buildKeyTree, flattenTree, allFolderPaths, windowSlice } from '../redisKeyTree';
import type { RedisKeyItem } from '../dbHelper';

const k = (key: string, type = 'string', ttl = -1): RedisKeyItem => ({ key, type, ttl });

/** Compact view of the flattened rows: "depth:kind:label". */
const shape = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((r) => `${r.depth}:${r.kind}:${r.label}`);

describe('buildKeyTree', () => {
  it('groups by the delimiter and counts the whole subtree', () => {
    const tree = buildKeyTree([k('user:1'), k('user:2'), k('cache:a:b')], ':');
    expect(tree.count).toBe(3);
    expect([...tree.folders.keys()].sort()).toEqual(['cache', 'user']);
    expect(tree.folders.get('user')!.count).toBe(2);
    expect(tree.folders.get('cache')!.count).toBe(1);
    expect(tree.folders.get('cache')!.folders.get('a')!.count).toBe(1);
  });

  it('keeps a key with no delimiter at the root instead of making a folder for it', () => {
    const tree = buildKeyTree([k('plain'), k('user:1')], ':');
    expect(tree.keys.map((i) => i.key)).toEqual(['plain']);
    expect([...tree.folders.keys()]).toEqual(['user']);
  });

  it('lets a name be both a key and a folder', () => {
    // `user` and `user:1` commonly coexist; neither may hide the other.
    const tree = buildKeyTree([k('user'), k('user:1')], ':');
    expect(tree.keys.map((i) => i.key)).toEqual(['user']);
    expect(tree.folders.get('user')!.keys.map((i) => i.key)).toEqual(['user:1']);
  });

  it('puts every key at the root when grouping is off', () => {
    const tree = buildKeyTree([k('a:b'), k('c:d')], '');
    expect(tree.folders.size).toBe(0);
    expect(tree.keys).toHaveLength(2);
  });

  it('handles a trailing delimiter and an empty segment', () => {
    const tree = buildKeyTree([k('a:'), k('a::b')], ':');
    // `a:` is an empty-labelled key inside folder `a`
    expect(tree.folders.get('a')!.keys.map((i) => i.key)).toEqual(['a:']);
    // `a::b` goes through an empty-named folder
    expect(tree.folders.get('a')!.folders.has('')).toBe(true);
  });

  it('supports a multi-character delimiter', () => {
    const tree = buildKeyTree([k('a::b'), k('a::c')], '::');
    expect(tree.folders.get('a')!.count).toBe(2);
  });

  it('does not choke on an empty key list', () => {
    const tree = buildKeyTree([], ':');
    expect(tree.count).toBe(0);
    expect(flattenTree(tree, new Set())).toEqual([]);
  });
});

describe('flattenTree', () => {
  const tree = buildKeyTree([k('user:2'), k('user:1'), k('cache:x'), k('plain')], ':');

  it('lists folders (sorted) before keys and hides collapsed children', () => {
    expect(shape(flattenTree(tree, new Set()))).toEqual([
      '0:folder:cache',
      '0:folder:user',
      '0:key:plain',
    ]);
  });

  it('descends only into expanded folders and shows the last segment', () => {
    expect(shape(flattenTree(tree, new Set(['user:'])))).toEqual([
      '0:folder:cache',
      '0:folder:user',
      '1:key:1',
      '1:key:2',
      '0:key:plain',
    ]);
  });

  it('sorts keys deterministically, not by locale', () => {
    const t = buildKeyTree([k('n:b'), k('n:a'), k('n:B')], ':');
    // Codepoint order: 'B' (0x42) before 'a' (0x61)
    expect(shape(flattenTree(t, new Set(['n:'])))).toEqual([
      '0:folder:n',
      '1:key:B',
      '1:key:a',
      '1:key:b',
    ]);
  });

  it('carries the full key on the row even though only the segment is shown', () => {
    const rows = flattenTree(tree, new Set(['user:']));
    const row = rows.find((r) => r.kind === 'key' && r.label === '1');
    expect(row && row.kind === 'key' && row.item.key).toBe('user:1');
  });
});

describe('allFolderPaths', () => {
  it('returns every nested folder path', () => {
    const tree = buildKeyTree([k('a:b:c'), k('a:d'), k('e:f')], ':');
    expect(allFolderPaths(tree).sort()).toEqual(['a:', 'a:b:', 'e:']);
  });
});

describe('windowSlice', () => {
  it('renders a window around the scroll position with overscan', () => {
    const w = windowSlice(1000, 400, 20, 5000, 8);
    // 1000/20 = row 50, minus 8 overscan
    expect(w.start).toBe(42);
    // 20 visible + 16 overscan
    expect(w.end).toBe(78);
    expect(w.padTop).toBe(42 * 20);
    expect(w.padBottom).toBe((5000 - 78) * 20);
  });

  it('clamps at the top', () => {
    const w = windowSlice(0, 400, 20, 5000);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it('clamps at the bottom', () => {
    const w = windowSlice(100_000, 400, 20, 5000);
    expect(w.end).toBe(5000);
    expect(w.padBottom).toBe(0);
  });

  it('handles a list shorter than the viewport', () => {
    const w = windowSlice(0, 400, 20, 3);
    expect(w).toEqual({ start: 0, end: 3, padTop: 0, padBottom: 0 });
  });

  it('handles an empty list and a zero row height without dividing by zero', () => {
    expect(windowSlice(0, 400, 20, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(windowSlice(0, 400, 0, 10).end).toBe(10);
  });

  it('never returns a negative scroll offset', () => {
    // Some browsers report a negative scrollTop while rubber-banding.
    const w = windowSlice(-50, 400, 20, 100);
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });
});
