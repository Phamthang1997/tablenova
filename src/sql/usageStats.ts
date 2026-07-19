// Đếm tần suất dùng (bảng/cột được chọn từ autocomplete) để xếp hạng gợi ý. Lưu localStorage.
const KEY = 'sql_usage_stats';
let cache: Record<string, number> | null = null;

function load(): Record<string, number> {
  if (!cache) {
    try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch { cache = {}; }
  }
  return cache!;
}

export function bumpUsage(name: string): void {
  if (!name) return;
  const m = load();
  m[name] = (m[name] || 0) + 1;
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

export function usageScore(name: string): number {
  return load()[name] || 0;
}

// sortText: trong cùng tier, tần suất cao xếp trước (số nhỏ hơn sắp trước theo lexicographic).
export function rankSort(tier: string, name: string): string {
  const inv = String(Math.max(0, 999999 - usageScore(name))).padStart(6, '0');
  return `${tier}_${inv}_${name}`;
}
