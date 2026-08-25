import { describe, it, expect } from 'vitest';
import { SQL_EDITOR_OPTIONS } from '../../sql/editorOptions';
import { rankSort } from '../../sql/usageStats';

/**
 * Thứ tự gợi ý của trình viết SQL nằm hoàn toàn trong `sortText` (xem sqlLanguage.ts).
 * Hai test dưới đây khoá lại thứ tự đó, và khoá luôn tuỳ chọn Monaco duy nhất có thể
 * âm thầm vô hiệu hoá nó.
 */

/** Đúng các tier mà sqlLanguage.ts phát ra, từ ưu tiên cao xuống thấp. */
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
    // '0_...' luôn nhỏ hơn '1_...' nên không có cột nào chen lên trên được.
    expect('0_0' < rankSort('1', 'a')).toBe(true);
    expect('0_9' < rankSort('1', 'zzz')).toBe(true);
  });

  it("snippetSuggestions phải là 'inline'", () => {
    // 'bottom'/'top' bắt Monaco gom mọi item kind=Snippet về một đầu danh sách và BỎ QUA
    // sortText của chúng. Điều kiện JOIN và mục "liệt kê N cột" đều là Snippet, nên đặt
    // 'bottom' làm chúng bị dìm xuống dưới hàng chục cột — đúng bug đã gặp.
    expect(SQL_EDITOR_OPTIONS.snippetSuggestions).toBe('inline');
  });

  it('không lấy gợi ý từ nội dung văn bản', () => {
    // Chỉ gợi ý từ catalog DB + parser; bật lên sẽ trộn thêm từ trong câu lệnh đang gõ.
    expect(SQL_EDITOR_OPTIONS.wordBasedSuggestions).toBe('off');
  });
});
