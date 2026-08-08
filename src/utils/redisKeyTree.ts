// Pure helpers for the Redis key browser: grouping keys by namespace, and the arithmetic
// behind the virtualized list. No React, no Tauri — both are unit-tested.
//
// WHY A TREE
// The browser used to render one flat row per key. On a database with a million keys under
// `session:`, `cache:` and `queue:` that is both unreadable and unrenderable.
//
// WHY WINDOWING IS HAND-WRITTEN
// The app has no virtualization dependency and the maths is ~15 lines; adding one for this
// would be a new dependency in the WebView for something testable in place (the same
// reasoning as writing the PRNG in `data_generator.rs` instead of pulling in `rand`).

import type { RedisKeyItem } from './dbHelper';

export interface TreeNode {
  /** Last segment of the path (`''` for the root). */
  label: string;
  /** Full prefix including trailing delimiter — the identity used for expand state. */
  path: string;
  folders: Map<string, TreeNode>;
  /** Keys that live directly at this level, not in a sub-folder. */
  keys: RedisKeyItem[];
  /** Keys in this subtree, including children. */
  count: number;
}

export type TreeRow =
  | { kind: 'folder'; path: string; label: string; depth: number; count: number; expanded: boolean }
  | { kind: 'key'; item: RedisKeyItem; label: string; depth: number };

function emptyNode(label: string, path: string): TreeNode {
  return { label, path, folders: new Map(), keys: [], count: 0 };
}

/**
 * Groups keys by `delimiter` (`:` by convention). An empty delimiter disables grouping and
 * returns every key at the root, which is also the fallback for keys with no delimiter in
 * them.
 *
 * A name can be both a key and a folder (`user` and `user:1` often coexist); the two are
 * kept in separate collections so neither hides the other.
 */
export function buildKeyTree(keys: RedisKeyItem[], delimiter: string): TreeNode {
  const root = emptyNode('', '');
  for (const item of keys) {
    root.count++;
    if (!delimiter) {
      root.keys.push(item);
      continue;
    }
    const parts = item.key.split(delimiter);
    // No delimiter in the key -> it belongs at the root, not in a folder named after itself.
    if (parts.length === 1) {
      root.keys.push(item);
      continue;
    }
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const label = parts[i];
      const path = `${node.path}${label}${delimiter}`;
      let child = node.folders.get(label);
      if (!child) {
        child = emptyNode(label, path);
        node.folders.set(label, child);
      }
      node = child;
      // Counted on every ancestor so a collapsed folder can show its subtree total.
      if (node !== root) node.count++;
    }
    node.keys.push(item);
  }
  return root;
}

/** Deterministic ordering: plain codepoint compare, not `localeCompare` (locale-dependent). */
function byLabel(a: { label: string }, b: { label: string }): number {
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * Flattens the tree into the row list the virtualized viewport renders: folders first (sorted),
 * then keys, and only descending into folders present in `expanded`.
 */
export function flattenTree(root: TreeNode, expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, depth: number) => {
    const folders = [...node.folders.values()].sort(byLabel);
    for (const f of folders) {
      const isOpen = expanded.has(f.path);
      rows.push({
        kind: 'folder',
        path: f.path,
        label: f.label,
        depth,
        count: f.count,
        expanded: isOpen,
      });
      if (isOpen) walk(f, depth + 1);
    }
    const keys = [...node.keys].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const item of keys) {
      // Only the last segment is shown; the full key stays in `item.key` for the tooltip.
      const label = node.path && item.key.startsWith(node.path)
        ? item.key.slice(node.path.length)
        : item.key;
      rows.push({ kind: 'key', item, label, depth });
    }
  };
  walk(root, 0);
  return rows;
}

/** Every folder path in the tree — used by "expand all". */
export function allFolderPaths(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    for (const f of node.folders.values()) {
      out.push(f.path);
      walk(f);
    }
  };
  walk(root);
  return out;
}

export interface WindowSlice {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Which rows to actually render for a given scroll position, plus the spacer heights that
 * keep the scrollbar honest. `overscan` rows above and below absorb fast scrolling.
 */
export function windowSlice(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan = 8,
): WindowSlice {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: total > 0 ? total : 0, padTop: 0, padBottom: 0 };
  }
  const top = Math.max(0, scrollTop);
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(total, start + visible + overscan * 2);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (total - end) * rowHeight),
  };
}
