// Chrome-style tab groups: the types plus the pure logic.
//
// Split out of TabManager.tsx for two reasons. First, oxlint enables
// `react/only-export-components`, so a component file may not export a constant
// like TAB_GROUP_COLORS. Second, and more importantly: the two functions below
// are where the whole feature's invariant is kept, and being pure here makes them
// testable (see __tests__/tabGroups.test.ts) — inside App.tsx the only way to
// check them would be by hand.
//
// INVARIANT: tabs of one group are always ADJACENT in the `tabs` array.
// TabManager builds the tab strip in a single pass, opening a new cluster every
// time `groupId` changes, so an interrupted group renders as two clusters that
// share a name.

import type { TabInfo } from '../components/TabManager';

export interface TabGroup {
  id: string;
  name: string;
  /** Hex colour, taken from TAB_GROUP_COLORS. */
  color: string;
  collapsed?: boolean;
}

/**
 * The group palette. A new group takes the next colour in the cycle, so two
 * groups created in a row never share one, and the user still picks nothing.
 */
export const TAB_GROUP_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];

/**
 * Moves a tab into a group, relocating it so the invariant above still holds.
 *
 * The insertion point is decided in this order, matching how Chrome behaves:
 *
 * 1. The target group already has members -> insert right after its last member.
 * 2. The target group is empty (just created) but the tab currently sits in
 *    another group -> insert right after the OLD group's run. Leaving it where it
 *    is would not do: a tab in the middle of its old group that changes groupId
 *    cuts that group in two.
 * 3. Otherwise (a loose tab creating a group for itself) -> KEEP ITS POSITION.
 *    This is what the first version got wrong: it fell into the "empty group"
 *    branch and threw the tab to the end of the run, so hitting "New group" on a
 *    tab in the middle sent it flying to the far right. Staying put is safe here:
 *    while the invariant holds, a loose tab never sits inside another group's run.
 *
 * Returns `list` itself when the tab is not found, so a caller's setState does
 * not build a new array for nothing.
 */
export function moveTabIntoGroup(
  list: TabInfo[],
  tabId: string,
  groupId: string | undefined,
): TabInfo[] {
  const from = list.findIndex((tab) => tab.id === tabId);
  if (from === -1) return list;

  const rest = list.filter((tab) => tab.id !== tabId);
  const moved: TabInfo = { ...list[from], groupId };
  const oldGroup = list[from].groupId;

  const lastOf = (id: string) => rest.map((tab) => tab.groupId).lastIndexOf(id);

  let insertAt = from;
  const lastOfTarget = groupId ? lastOf(groupId) : -1;
  if (lastOfTarget !== -1) {
    insertAt = lastOfTarget + 1;
  } else if (oldGroup) {
    const lastOfOld = lastOf(oldGroup);
    insertAt = lastOfOld === -1 ? from : lastOfOld + 1;
  }

  rest.splice(insertAt, 0, moved);
  return rest;
}

/**
 * Moves a tab from `from` to `to` (a drag on the tab strip).
 *
 * `targetGroupId` is the group whose area the pointer was inside when it was
 * dropped, decided by TabManager from the geometry of the .tab-group cluster
 * itself — `undefined` means dropped outside every group. The first version
 * inferred the group from the two NEIGHBOURING tabs after the splice, which meant
 * dropping on the edge of a group (a member on one side, none on the other) did
 * not join it — so the most natural gesture for appending a tab to a group was
 * exactly the one that slipped.
 *
 * When the group changes, placement is handed entirely to `moveTabIntoGroup`:
 * that is the only place keeping the "one group stays adjacent" invariant, and it
 * handles the cases a raw drop position cannot (dropping onto the chip of a
 * collapsed group, whose tabs are hidden so there is no slot to insert into).
 */
export function reorderTabs(
  list: TabInfo[],
  from: number,
  to: number,
  targetGroupId: string | undefined,
): TabInfo[] {
  if (from < 0 || from >= list.length) return list;

  const tab = list[from];
  if ((targetGroupId ?? undefined) !== (tab.groupId ?? undefined)) {
    return moveTabIntoGroup(list, tab.id, targetGroupId);
  }

  // Same group reordering within contiguous range.
  
  if (from === to || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Moves an ENTIRE group (dragging its chip) to where the tab at `targetIndex` sits.
 *
 * The group's whole run travels together. The part to be careful about: the drop
 * can land in the middle of ANOTHER group's run, and inserting straight there cuts
 * that group in two. So when the target tab belongs to a different group, the
 * insertion point is pushed out to that group's edge: its left edge when dragging
 * left, its right edge when dragging right.
 */
export function moveGroup(list: TabInfo[], groupId: string, targetIndex: number): TabInfo[] {
  const start = list.findIndex((tab) => tab.groupId === groupId);
  if (start === -1 || targetIndex < 0 || targetIndex >= list.length) return list;
  // Dragged onto same group -> no-op.
  if (list[targetIndex].groupId === groupId) return list;

  const block = list.filter((tab) => tab.groupId === groupId);
  const rest = list.filter((tab) => tab.groupId !== groupId);
  const target = list[targetIndex];
  const movingLeft = targetIndex < start;

  const j = rest.findIndex((tab) => tab.id === target.id);
  let insertAt: number;
  if (target.groupId) {
    // Snaps to outer boundary of target group, never splitting it.
    insertAt = movingLeft
      ? rest.findIndex((tab) => tab.groupId === target.groupId)
      : rest.map((tab) => tab.groupId).lastIndexOf(target.groupId) + 1;
  } else {
    insertAt = movingLeft ? j : j + 1;
  }

  rest.splice(insertAt, 0, ...block);
  return rest;
}
