import { describe, expect, it, beforeEach } from 'vitest';
import { createConnPref } from '../connPrefs';

// Cùng lý do như `safeMode.test.ts`: Vitest chạy `environment: 'node'`, không có localStorage, nên
// cài bản nhỏ nhất hành xử giống nó.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
} satisfies Storage;

/** Bản sao của thiết lập "giới hạn thời gian": số > 0, mặc định 0. */
const makeSecs = (storageKey: string) =>
  createConnPref<number>(storageKey, 'test-secs-changed', 0, (raw) =>
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null,
  );

/** Bản sao của thiết lập "xem trước SQL": chỉ `false` được lưu, mặc định `true`. */
const makeFlag = (storageKey: string) =>
  createConnPref<boolean>(storageKey, 'test-flag-changed', true, (raw) => (raw === false ? false : null));

describe('createConnPref', () => {
  beforeEach(() => memory.clear());

  it('returns the default for a server it has never stored', () => {
    expect(makeSecs('k1').get('pg:a:5432')).toBe(0);
    expect(makeFlag('k2').get('pg:a:5432')).toBe(true);
  });

  it('stores and reads per server, without touching the others', () => {
    const p = makeSecs('k3');
    p.set('pg:a:5432', 30);
    expect(p.get('pg:a:5432')).toBe(30);
    expect(p.get('pg:b:5432')).toBe(0);
  });

  it('DELETES the entry when the value is the default, instead of writing it', () => {
    // Nếu không thì localStorage phình lên một dòng cho mỗi server người dùng từng mở.
    const p = makeSecs('k4');
    p.set('pg:a:5432', 30);
    p.set('pg:a:5432', 0);
    expect(JSON.parse(memory.get('k4') as string)).toEqual({});
    expect(p.get('pg:a:5432')).toBe(0);
  });

  it('ignores a key it cannot attribute to a server', () => {
    // Key rỗng = "chưa biết đây là server nào"; ghi vào đó là ghi cho mọi server một lúc.
    const p = makeFlag('k5');
    p.set('', false);
    expect(memory.get('k5')).toBeUndefined();
    expect(p.get('')).toBe(true);
  });

  it('falls back to the default for a stored value of the wrong shape', () => {
    memory.set('k6', JSON.stringify({ 'pg:a:5432': 'nhanh lên', 'pg:b:5432': -5 }));
    const p = makeSecs('k6');
    expect(p.get('pg:a:5432')).toBe(0);
    expect(p.get('pg:b:5432')).toBe(0);
  });

  it('survives storage holding something that is not an object', () => {
    memory.set('k7', '"not json object"');
    expect(makeFlag('k7').get('pg:a:5432')).toBe(true);
  });

  it('keeps two prefs apart even for the same server', () => {
    const secs = makeSecs('k8');
    const flag = makeFlag('k9');
    secs.set('pg:a:5432', 15);
    flag.set('pg:a:5432', false);
    expect(secs.get('pg:a:5432')).toBe(15);
    expect(flag.get('pg:a:5432')).toBe(false);
  });
});
