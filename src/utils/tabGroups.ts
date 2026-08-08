// Nhóm tab kiểu Chrome: kiểu dữ liệu + phần logic thuần.
//
// Tách khỏi TabManager.tsx vì hai lý do. Thứ nhất, oxlint bật
// `react/only-export-components`, nên một file component không được export hằng
// như TAB_GROUP_COLORS. Thứ hai, và quan trọng hơn: hai hàm dưới đây là nơi bất
// biến của cả tính năng được giữ, và ở đây chúng thuần nên test được (xem
// __tests__/tabGroups.test.ts) — nằm trong App.tsx thì chỉ còn cách thử tay.
//
// BẤT BIẾN: các tab cùng một nhóm luôn NẰM LIỀN NHAU trong mảng `tabs`.
// TabManager dựng thanh tab bằng cách quét mảng một lượt và mở cụm mới mỗi khi
// `groupId` đổi, nên một nhóm bị ngắt quãng sẽ hiện thành hai cụm trùng tên.

import type { TabInfo } from '../components/TabManager';

export interface TabGroup {
  id: string;
  name: string;
  /** Mã màu hex, lấy từ TAB_GROUP_COLORS. */
  color: string;
  collapsed?: boolean;
}

/**
 * Bảng màu nhóm. Nhóm mới lấy màu kế tiếp theo vòng để hai nhóm tạo liên tiếp
 * không trùng màu, mà người dùng vẫn không phải chọn gì lúc tạo.
 */
export const TAB_GROUP_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];

/**
 * Đổi nhóm của một tab, đồng thời dời nó về đúng chỗ để bất biến trên còn đúng.
 *
 * Thứ tự xét chỗ chèn, theo đúng cách Chrome hành xử:
 *
 * 1. Nhóm đích đã có thành viên -> chèn ngay sau thành viên cuối của nhóm đó.
 * 2. Nhóm đích còn rỗng (vừa tạo) nhưng tab đang nằm trong một nhóm khác ->
 *    chèn ngay sau dải của nhóm CŨ. Không được để nguyên tại chỗ: một tab ở giữa
 *    nhóm cũ mà đổi groupId sẽ cắt nhóm đó làm đôi.
 * 3. Còn lại (tab rời, tạo nhóm mới cho chính nó) -> GIỮ NGUYÊN VỊ TRÍ. Đây là
 *    điểm bản đầu làm sai: nó rơi vào nhánh "nhóm rỗng" rồi ném tab về cuối dải,
 *    nên bấm "Nhóm mới" trên một tab ở giữa là thấy tab nhảy sang tận phải.
 *    Giữ nguyên chỗ ở đây an toàn: nếu bất biến đang đúng thì một tab rời không
 *    bao giờ nằm lọt giữa dải của nhóm nào cả.
 *
 * Trả về chính `list` khi không tìm thấy tab, để người gọi setState không tạo
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
 * Dời tab từ vị trí `from` tới `to` (kéo thả trên thanh tab).
 *
 * `targetGroupId` là nhóm mà con trỏ đang nằm trong vùng của nó lúc thả, do
 * TabManager xác định bằng hình học của chính cụm .tab-group — `undefined` nghĩa
 * là thả ra ngoài mọi nhóm. Bản đầu suy ra nhóm từ hai tab HÀNG XÓM sau khi
 * splice, và như thế thả vào mép nhóm (một bên là thành viên, bên kia không)
 * lại không nhận nhóm — đúng thao tác tự nhiên nhất khi muốn thêm tab vào cuối
 * một nhóm thì lại trượt.
 *
 * Khi nhóm thay đổi, việc đặt chỗ giao hết cho `moveTabIntoGroup`: đó là chỗ duy
 * nhất giữ bất biến "cùng nhóm nằm liền nhau", và nó xử lý được cả những ca mà
 * vị trí thả thô không xử lý nổi (thả lên chip của một nhóm đang thu gọn, tab
 * của nhóm đó đang bị giấu nên không có vị trí nào để chèn vào).
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

  // Cùng nhóm (hoặc cùng "không nhóm"): thuần đổi chỗ. Con trỏ đã ở trong vùng
  // của nhóm đó nên `to` chắc chắn nằm trong dải của nhóm, bất biến không đụng.
  if (from === to || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Dời NGUYÊN một nhóm (kéo chip của nhóm) tới chỗ của tab ở `targetIndex`.
 *
 * Cả dải tab của nhóm đi cùng nhau. Điểm phải cẩn thận: chỗ thả có thể rơi vào
 * giữa dải của một nhóm KHÁC — chèn thẳng vào đó là cắt nhóm kia làm đôi. Nên
 * khi tab đích thuộc một nhóm khác, chỗ chèn được đẩy ra mép của cả nhóm đó:
 * mép trái nếu đang kéo sang trái, mép phải nếu kéo sang phải.
 */
export function moveGroup(list: TabInfo[], groupId: string, targetIndex: number): TabInfo[] {
  const start = list.findIndex((tab) => tab.groupId === groupId);
  if (start === -1 || targetIndex < 0 || targetIndex >= list.length) return list;
  // Thả vào chính nhóm đang kéo thì không có gì để làm.
  if (list[targetIndex].groupId === groupId) return list;

  const block = list.filter((tab) => tab.groupId === groupId);
  const rest = list.filter((tab) => tab.groupId !== groupId);
  const target = list[targetIndex];
  const movingLeft = targetIndex < start;

  const j = rest.findIndex((tab) => tab.id === target.id);
  let insertAt: number;
  if (target.groupId) {
    // Snap ra mép của nhóm đích, không bao giờ chèn vào giữa nó.
    insertAt = movingLeft
      ? rest.findIndex((tab) => tab.groupId === target.groupId)
      : rest.map((tab) => tab.groupId).lastIndexOf(target.groupId) + 1;
  } else {
    insertAt = movingLeft ? j : j + 1;
  }

  rest.splice(insertAt, 0, ...block);
  return rest;
}
