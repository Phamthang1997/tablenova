// Một thiết lập save **theo server** (`connKey`), in localStorage, có phát sự kiện when đổi.
//
// Đây is khuôn chung, not must một thiết lập cụ thể. `safeMode.ts` viết tay đoạn này trước (nó
// cần add phần categorize command nên vẫn giữ bản riêng), rồi `stmtTimeout` and "preview SQL when
// save" lặp lại y nguyên: read localStorage một lần rồi write nhớ, delete entry when giá trị bằng default,
// bỏ cache when window khác write, phát một `CustomEvent` to control currently open tự cập nhật. Bản sao thứ
// ba is lúc must stop lại — bốn row logic đó sai at một bản is một thiết lập âm thầm not save.
//
// Hai quy tắc nằm in khuôn này, not must at chỗ dùng:
//
//  - **default thì delete entry** thay vì write giá trị default. Nhờ vậy localStorage not phình lên
//    một row for mỗi server user fromng open, and một bản write cũ (trước when thiết lập này tồn
//    tại) read ra đúng default chứ not must `undefined`.
//  - **Key rỗng thì trả default and not write gì.** Key rỗng nghĩa is "chưa biết đây is server
//    nào" (`connKey` of một config chưa đủ thông tin); write ando đó is write for mọi server một lúc.

/** read/write một thiết lập theo server, cùng tên sự kiện to nghe when nó đổi. */
export interface ConnPref<T> {
  /** Tên `CustomEvent` phát ra sau mỗi lần write. */
  readonly EVENT: string;
  get(key: string): T;
  set(key: string, value: T): void;
}

/**
 * build một thiết lập theo server.
 *
 * `normalize` receive giá trị thô lấy from JSON and returns `null` when nó not dùng is (kiểu sai, ngoài
 * miền giá trị, hay đúng bằng default) — `null` nghĩa is "dùng default", nên một entry rác not
 * bao giờ thành một giá trị lạ, and `set` cũng dùng chính hàm này to quyết định delete entry hay write.
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
        // Hết quota thì giá trị not save lại is, nhưng control not is trông như is hỏng.
      }
      // under Vitest (`environment: 'node'`) not có `window` — chặn thay vì ism module chết lúc import.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(event));
      }
    },
  };
}
