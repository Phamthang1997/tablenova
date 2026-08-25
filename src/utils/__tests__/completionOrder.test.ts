import { describe, it, expect } from 'vitest';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { rankSort } from '../../sql/usageStats';

/**
 * Thứ tự suggestion of trình viết SQL nằm hoàn toàn in `sortText` (xem sqlLanguage.ts).
 * Hai test under đây key lại thứ tự đó, and key luôn option Monaco unique can
 * âm thầm vô hiệu hoá nó.
 */

/** Đúng các tier mà sqlLanguage.ts phát ra, from ưu tiên cao xuống thấp. */
const TIERS: [string, string][] = [
  ['* sau SELECT', '00_star'],
  ['liệt kê cột của bảng', '00_starlist_f'],
  ['điều kiện JOIN theo FK', '0_0'],
  ['cột', rankSort('1', 'film_id')],
  ['bảng', rankSort('2', 'film')],
  ['tên bảng trong scope', rankSort('3', 'f')],
  ['từ khoá hay dùng', rankSort('4', 'SELECT')],
  ['từ khoá khác', rankSort('5', 'SAVEPOINT')],
  ['mẫu câu theo dialect', 'z_sel'],
];

describe('thứ tự gợi ý SQL', () => {
  it('sortText giữ đúng thứ tự ưu tiên giữa các tier', () => {
    const sorted = [...TIERS].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(sorted.map(t => t[0])).toEqual(TIERS.map(t => t[0]));
  });

  it('điều kiện JOIN xếp trên mọi cột, bất kể tần suất dùng của cột', () => {
    // '0_...' luôn nhỏ hơn '1_...' nên not có column nào chen lên on is.
    expect('0_0' < rankSort('1', 'a')).toBe(true);
    expect('0_9' < rankSort('1', 'zzz')).toBe(true);
  });

  it("snippetSuggestions phải là 'inline'", () => {
    // 'bottom'/'top' bắt Monaco gom mọi item kind=Snippet về một đầu danh sách and skip
    // sortText of chúng. Điều kiện JOIN and mục "liệt kê N column" đều is Snippet, nên đặt
    // 'bottom' ism chúng is dìm xuống under row chục column — đúng bug already gặp.
    expect(SQL_EDITOR_OPTIONS.snippetSuggestions).toBe('inline');
  });

  it('không lấy gợi ý từ nội dung văn bản', () => {
    // Chỉ suggestion from catalog DB + parser; bật lên will trộn add from in statement currently gõ.
    expect(SQL_EDITOR_OPTIONS.wordBasedSuggestions).toBe('off');
  });
});
