// Một thiết lập lưu **theo server** (`connKey`), trong localStorage, có phát sự kiện khi đổi.
//
// Đây là khuôn chung, không phải một thiết lập cụ thể. `safeMode.ts` viết tay đoạn này trước (nó
// cần thêm phần phân loại command nên vẫn giữ bản riêng), rồi `stmtTimeout` và "xem trước SQL khi
// lưu" lặp lại y nguyên: đọc localStorage một lần rồi ghi nhớ, xoá entry khi giá trị bằng mặc định,
// bỏ cache khi cửa sổ khác ghi, phát một `CustomEvent` để control đang mở tự cập nhật. Bản sao thứ
// ba là lúc phải dừng lại — bốn dòng logic đó sai ở một bản là một thiết lập âm thầm không lưu.
//
// Hai quy tắc nằm trong khuôn này, không phải ở chỗ dùng:
//
//  - **Mặc định thì XOÁ entry** thay vì ghi giá trị mặc định. Nhờ vậy localStorage không phình lên
//    một dòng cho mỗi server người dùng từng mở, và một bản ghi cũ (trước khi thiết lập này tồn
//    tại) đọc ra đúng mặc định chứ không phải `undefined`.
//  - **Key rỗng thì trả mặc định và không ghi gì.** Key rỗng nghĩa là "chưa biết đây là server
//    nào" (`connKey` của một config chưa đủ thông tin); ghi vào đó là ghi cho mọi server một lúc.

/** Đọc/ghi một thiết lập theo server, cùng tên sự kiện để nghe khi nó đổi. */
export interface ConnPref<T> {
  /** Tên `CustomEvent` phát ra sau mỗi lần ghi. */
  readonly EVENT: string;
  get(key: string): T;
  set(key: string, value: T): void;
}

/**
 * Dựng một thiết lập theo server.
 *
 * `normalize` nhận giá trị thô lấy từ JSON và trả về `null` khi nó không dùng được (kiểu sai, ngoài
 * miền giá trị, hay đúng bằng mặc định) — `null` nghĩa là "dùng mặc định", nên một entry rác không
 * bao giờ thành một giá trị lạ, và `set` cũng dùng chính hàm này để quyết định xoá entry hay ghi.
 */
export function createConnPref<T>(
  storageKey: string,
  event: string,
  fallback: T,
  normalize: (raw: unknown) => T | null,
): ConnPref<T> {
  let cache: Record<string, unknown> | null = null;

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key === null || e.key === storageKey) cache = null;
    });
  }

  const readAll = (): Record<string, unknown> => {
    if (cache) return cache;
    try {
      if (typeof localStorage === 'undefined') return (cache = {});
      const raw = localStorage.getItem(storageKey);
      if (!raw) return (cache = {});
      const parsed = JSON.parse(raw);
      return (cache = parsed && typeof parsed === 'object' ? parsed : {});
    } catch {
      return (cache = {});
    }
  };

  return {
    EVENT: event,

    get(key: string): T {
      if (!key) return fallback;
      return normalize(readAll()[key]) ?? fallback;
    },

    set(key: string, value: T): void {
      if (!key) return;
      const all = { ...readAll() };
      const normalized = normalize(value);
      if (normalized === null) delete all[key];
      else all[key] = normalized;
      cache = all;
      try {
        localStorage.setItem(storageKey, JSON.stringify(all));
      } catch {
        // Hết quota thì giá trị không lưu lại được, nhưng control không được trông như bị hỏng.
      }
      // Dưới Vitest (`environment: 'node'`) không có `window` — chặn thay vì làm module chết lúc import.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(event));
      }
    },
  };
}
