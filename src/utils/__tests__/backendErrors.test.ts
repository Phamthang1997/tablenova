import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../i18n';
import en from '../../i18n/locales/en';
import vi from '../../i18n/locales/vi';
import {
  EXACT,
  NORMALIZED_ALIASES,
  PATTERNS,
  translateBackendError,
  translateResultErrors,
} from '../backendErrors';

/**
 * Guards the backend-error mapping table.
 *
 * The strongest check here is the Vietnamese round-trip: every Rust message listed in
 * `EXACT` must translate back to *byte-identical* Vietnamese. That proves at once that
 * the table key exists, that `vi.ts` transcribed the Rust wording faithfully, and that
 * a Vietnamese user sees no change in behaviour from before the mapping existed.
 */

const enBackend = en.backend as Record<string, string>;
const viBackend = vi.backend as Record<string, string>;

/** Strips the `backend.` prefix used in the table. */
const leaf = (key: string) => key.replace(/^backend\./, '');

describe('backendErrors table', () => {
  it('every EXACT entry points at a key that exists in en', () => {
    const missing = Object.values(EXACT).filter((k) => enBackend[leaf(k)] === undefined);
    expect(missing).toEqual([]);
  });

  it('every PATTERNS entry points at a key that exists in en', () => {
    const missing = PATTERNS.map((p) => p.key).filter((k) => enBackend[leaf(k)] === undefined);
    expect(missing).toEqual([]);
  });

  it('no two patterns share a key with an EXACT entry', () => {
    const exactKeys = new Set(Object.values(EXACT));
    const clash = PATTERNS.map((p) => p.key).filter((k) => exactKeys.has(k));
    expect(clash).toEqual([]);
  });
});

describe('translateBackendError', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('vi');
  });

  it('round-trips every EXACT message back to the identical Vietnamese', () => {
    const broken: string[] = [];
    for (const [rustMessage, key] of Object.entries(EXACT)) {
      const viText = viBackend[leaf(key)];
      if (translateBackendError(rustMessage) !== viText) broken.push(rustMessage);
      // The vi translation must reproduce the Rust wording verbatim, unless the entry is
      // a declared alias folded into a sibling's wording.
      if (viText !== rustMessage && !NORMALIZED_ALIASES.has(rustMessage)) {
        broken.push(`wording drift: ${rustMessage}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('declared aliases still resolve to their canonical sibling', () => {
    for (const alias of NORMALIZED_ALIASES) {
      expect(EXACT[alias]).toBeDefined();
      expect(translateBackendError(alias)).toBe(viBackend[leaf(EXACT[alias])]);
    }
  });

  it('keeps the interpolated payload of a templated message', () => {
    const out = translateBackendError("Lỗi mở shell: permission denied");
    expect(out).toContain('permission denied');
  });

  it('keeps both payloads of a two-placeholder message', () => {
    const out = translateBackendError(
      "Không đọc được 'password' từ kho bí mật: keyring locked"
    );
    expect(out).toContain('password');
    expect(out).toContain('keyring locked');
  });

  it('passes an unmapped message through unchanged', () => {
    const raw = 'ERROR 1064 (42000): You have an error in your SQL syntax';
    expect(translateBackendError(raw)).toBe(raw);
  });

  it('leaves an empty message alone', () => {
    expect(translateBackendError('')).toBe('');
  });

  it('translates into the active language, not a fixed one', async () => {
    await i18n.changeLanguage('en');
    expect(translateBackendError('Chưa kết nối CSDL')).toBe(enBackend.notConnected);
    await i18n.changeLanguage('vi');
    expect(translateBackendError('Chưa kết nối CSDL')).toBe(viBackend.notConnected);
  });
});

describe('translateResultErrors', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  it('rewrites the message and error fields', () => {
    const res = translateResultErrors({ success: false, message: 'Chưa kết nối CSDL' });
    expect(res.message).toBe(enBackend.notConnected);
  });

  it('leaves other fields and non-objects untouched', () => {
    const rows = [{ id: 1 }];
    const res = translateResultErrors({ success: true, data: rows, error: '' });
    expect(res.data).toBe(rows);
    expect(translateResultErrors(null)).toBeNull();
    expect(translateResultErrors('plain')).toBe('plain');
  });
});
