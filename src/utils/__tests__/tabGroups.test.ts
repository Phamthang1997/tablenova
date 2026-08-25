import { describe, expect, it } from 'vitest';
import { moveGroup, moveTabIntoGroup, reorderTabs } from '../tabGroups';
import type { TabInfo } from '../../components/TabManager';

/**
 * Mỗi ca test check cùng một thứ: sau thao tác, các tab cùng nhóm còn nằm
 * liền nhau hay not. Đó is bất biến unique mà tab bar dựa ando to build cụm
 * nhóm — vỡ nó thì một nhóm hiện thành hai cụm trùng tên.
 */

const tab = (id: string, groupId?: string): TabInfo => ({
  id,
  type: 'query',
  name: id,
  label: id,
  ...(groupId ? { groupId } : {}),
});

const ids = (list: TabInfo[]) => list.map((it) => it.id);
const groupOf = (list: TabInfo[], id: string) => list.find((it) => it.id === id)?.groupId;

/** Mọi nhóm xuất hiện đúng một dải liên tục. */
function groupsAreContiguous(list: TabInfo[]): boolean {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const it of list) {
    if (it.groupId !== previous) {
      if (it.groupId) {
        if (seen.has(it.groupId)) return false;
        seen.add(it.groupId);
      }
      previous = it.groupId;
    }
  }
  return true;
}

describe('moveTabIntoGroup', () => {
  it('dời tab vào ngay sau thành viên cuối của nhóm', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c'), tab('d')];
    const next = moveTabIntoGroup(list, 'd', 'g1');
    expect(ids(next)).toEqual(['a', 'b', 'd', 'c']);
    expect(groupOf(next, 'd')).toBe('g1');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('tab rời nhóm được dời ra ngoài dải, không cắt nhóm làm đôi', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g1')];
    const next = moveTabIntoGroup(list, 'a', undefined);
    expect(ids(next)).toEqual(['b', 'c', 'a']);
    expect(groupOf(next, 'a')).toBeUndefined();
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('chuyển thẳng từ nhóm này sang nhóm khác vẫn giữ cả hai nhóm liền mạch', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g2'), tab('d', 'g2')];
    const next = moveTabIntoGroup(list, 'a', 'g2');
    expect(ids(next)).toEqual(['b', 'c', 'd', 'a']);
    expect(groupOf(next, 'a')).toBe('g2');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  // Ca này fromng khẳng định ngược lại (tab về cuối danh sách) and đó is bug: bấm
  // "Nhóm mới" on một tab at giữa thì thấy nó nhảy sang tận must. Chrome giữ
  // nguyên chỗ and mọc header nhóm ngay trước tab.
  it('tạo nhóm mới cho một tab rời -> tab đứng yên tại chỗ', () => {
    const list = [tab('a'), tab('b'), tab('c')];
    const next = moveTabIntoGroup(list, 'b', 'g-new');
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(groupOf(next, 'b')).toBe('g-new');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('tạo nhóm mới cho tab đang nằm GIỮA nhóm khác -> ra ngay sau nhóm cũ', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g1'), tab('d')];
    const next = moveTabIntoGroup(list, 'b', 'g-new');
    // preserve chỗ at đây will cắt g1 thành [a] ... [c], nên b must ra sau g1.
    expect(ids(next)).toEqual(['a', 'c', 'b', 'd']);
    expect(groupOf(next, 'b')).toBe('g-new');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('trả về đúng mảng cũ khi không có tab nào khớp', () => {
    const list = [tab('a')];
    expect(moveTabIntoGroup(list, 'khong-ton-tai', 'g1')).toBe(list);
  });
});

describe('reorderTabs', () => {
  it('thả vào vùng của một nhóm thì tab vào cuối nhóm đó', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c')];
    const next = reorderTabs(list, 2, 1, 'g1');
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(groupOf(next, 'c')).toBe('g1');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('thả ra ngoài mọi nhóm thì tab rời nhóm', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c')];
    const next = reorderTabs(list, 0, 2, undefined);
    expect(ids(next)).toEqual(['b', 'a', 'c']);
    expect(groupOf(next, 'a')).toBeUndefined();
    expect(groupsAreContiguous(next)).toBe(true);
  });

  // Ca này trước đây khẳng định ngược lại. Suy nhóm from hai tab row xóm whenến
  // thả ando MÉP nhóm not receive nhóm — mà thả ando mép must chính is thao tác tự
  // nhiên nhất when muốn add tab ando cuối một nhóm.
  it('thả vào mép nhóm vẫn vào nhóm, kể cả khi vị trí không đổi', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c')];
    const next = reorderTabs(list, 2, 2, 'g1');
    expect(groupOf(next, 'c')).toBe('g1');
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('đổi chỗ trong cùng một nhóm thì chỉ đổi thứ tự', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c', 'g1')];
    const next = reorderTabs(list, 0, 2, 'g1');
    expect(ids(next)).toEqual(['b', 'c', 'a']);
    expect(next.every((it) => it.groupId === 'g1')).toBe(true);
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('bỏ qua chỉ số ngoài phạm vi và trường hợp không đổi chỗ', () => {
    const list = [tab('a'), tab('b')];
    expect(reorderTabs(list, 1, 1, undefined)).toBe(list);
    expect(reorderTabs(list, -1, 0, undefined)).toBe(list);
    expect(reorderTabs(list, 0, 5, undefined)).toBe(list);
  });
});

describe('moveGroup', () => {
  it('dời cả dải tab của nhóm sang phải', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c'), tab('d')];
    const next = moveGroup(list, 'g1', 3);
    expect(ids(next)).toEqual(['c', 'd', 'a', 'b']);
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('dời cả dải tab của nhóm sang trái', () => {
    const list = [tab('a'), tab('b'), tab('c', 'g1'), tab('d', 'g1')];
    const next = moveGroup(list, 'g1', 1);
    expect(ids(next)).toEqual(['a', 'c', 'd', 'b']);
    expect(groupsAreContiguous(next)).toBe(true);
  });

  // Thả rơi ando giữa dải một nhóm khác thì must bật ra mép of nhóm đó, chèn
  // thẳng ando giữa will cắt nhóm kia ism đôi.
  it('không bao giờ chèn vào giữa một nhóm khác', () => {
    const list = [tab('a', 'g2'), tab('b', 'g2'), tab('c', 'g2'), tab('d', 'g1')];
    const next = moveGroup(list, 'g1', 1);
    expect(ids(next)).toEqual(['d', 'a', 'b', 'c']);
    expect(groupsAreContiguous(next)).toBe(true);
  });

  it('thả vào chính nó, hoặc chỉ số ngoài phạm vi -> không đổi', () => {
    const list = [tab('a', 'g1'), tab('b', 'g1'), tab('c')];
    expect(moveGroup(list, 'g1', 0)).toBe(list);
    expect(moveGroup(list, 'g1', 9)).toBe(list);
    expect(moveGroup(list, 'khong-ton-tai', 2)).toBe(list);
  });
});
