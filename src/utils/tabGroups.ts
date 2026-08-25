// tab group kiểu Chrome: kiểu dữ liệu + phần logic thuần.
//
// Tách khỏi TabManager.tsx vì hai lý do. Thứ nhất, oxlint bật
// `react/only-export-components`, nên một file component not is export hằng
// như TAB_GROUP_COLORS. Thứ hai, and quan trọng hơn: hai hàm under đây is nơi bất
// biến of cả tính năng is giữ, and at đây chúng thuần nên test is (xem
// __tests__/tabGroups.test.ts) — nằm in App.tsx thì chỉ còn cách thử tay.
//
// BẤT BIẾN: các tab cùng một nhóm luôn NẰM LIỀN NHAU in mảng `tabs`.
// TabManager build tab bar bằng cách quét mảng một lượt and open cụm mới mỗi when
// `groupId` đổi, nên một nhóm is ngắt quãng will hiện thành hai cụm trùng tên.

import type { TabInfo } from '../components/TabManager';

export interface TabGroup {
  id: string;
  name: string;
  /** Mã màu hex, lấy from TAB_GROUP_COLORS. */
  color: string;
  collapsed?: boolean;
}

/**
 * table màu nhóm. Nhóm mới lấy màu kế tiếp theo vòng to hai nhóm create liên tiếp
 * not trùng màu, mà user vẫn not must select gì lúc create.
 */
export const TAB_GROUP_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];

/**
 * Đổi nhóm of một tab, đồng thời dời nó về đúng chỗ to bất biến on còn đúng.
 *
 * Thứ tự xét chỗ chèn, theo đúng cách Chrome hành xử:
 *
 * 1. Nhóm đích already có thành viên -> chèn ngay sau thành viên cuối of nhóm đó.
 * 2. Nhóm đích còn rỗng (vừa create) nhưng tab currently nằm in một nhóm khác ->
 *    chèn ngay sau dải of nhóm CŨ. not is to nguyên tại chỗ: một tab at giữa
 *    nhóm cũ mà đổi groupId will cắt nhóm đó ism đôi.
 * 3. Còn lại (tab rời, create nhóm mới for chính nó) -> preserve position. Đây is
 *    điểm bản đầu ism sai: nó rơi ando nhánh "nhóm rỗng" rồi ném tab về cuối dải,
 *    nên bấm "Nhóm mới" on một tab at giữa is thấy tab nhảy sang tận must.
 *    preserve chỗ at đây an toàn: if bất biến currently đúng thì một tab rời not
 *    bao giờ nằm lọt giữa dải of nhóm nào cả.
 *
 * returns chính `list` when not find thấy tab, to người gọi setState not create
 * mảng mới vô ích.
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
 * Dời tab from position `from` tới `to` (drag and drop on tab bar).
 *
 * `targetGroupId` is nhóm mà con trỏ currently nằm in vùng of nó lúc thả, do
 * TabManager determines group target via geometric hit-testing on .tab-group element.
 
 
 
 
 *
 * Group assignment delegated to `moveTabIntoGroup` maintaining contiguous group invariant.
 
 
 
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
 * Moves ENTIRE group block (dragging group chip) to position at `targetIndex`.
 *
 * Snaps to edge of target group to avoid splitting contiguous group ranges.
 
 
 
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
