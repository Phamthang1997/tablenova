import { describe, it, expect } from 'vitest';
import en from '../locales/en';
import vi from '../locales/vi';
import ja from '../locales/ja';

/**
 * Runtime guard for the dictionaries.
 *
 * Key parity itself is already a compile error (`vi`/`ja` are typed
 * `typeof en`), so the point of these tests is what the type system cannot see:
 * an entry left empty, and interpolation placeholders dropped during
 * translation — a missing `{{name}}` in one language silently swallows the
 * value instead of failing.
 */

type Dict = Record<string, unknown>;

/** Flattens the nested dictionary into `a.b.c` -> value pairs. */
function flatten(obj: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(out, flatten(value as Dict, path));
    } else {
      out[path] = String(value);
    }
  }
  return out;
}

/** `{{name}}` tokens in a value, sorted so comparison ignores word order. */
function placeholders(value: string): string[] {
  return (value.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? [])
    .map((token) => token.replace(/[{}\s]/g, ''))
    .sort();
}

/** `<strong>` / `<code>` tags handed to <Trans>. */
function tags(value: string): string[] {
  return (value.match(/<\/?([a-zA-Z]+)>/g) ?? []).sort();
}

const flatEn = flatten(en as unknown as Dict);
const translations = { vi: flatten(vi as unknown as Dict), ja: flatten(ja as unknown as Dict) };

describe('locale dictionaries', () => {
  it('en has no empty value', () => {
    const empty = Object.keys(flatEn).filter((key) => flatEn[key].trim() === '');
    expect(empty).toEqual([]);
  });

  for (const [lang, flat] of Object.entries(translations)) {
    describe(lang, () => {
      it('has exactly the same keys as en', () => {
        expect(Object.keys(flat).sort()).toEqual(Object.keys(flatEn).sort());
      });

      it('has no empty value', () => {
        const empty = Object.keys(flat).filter((key) => flat[key].trim() === '');
        expect(empty).toEqual([]);
      });

      it('keeps every interpolation placeholder from en', () => {
        const mismatched = Object.keys(flatEn).filter(
          (key) => placeholders(flatEn[key]).join(',') !== placeholders(flat[key] ?? '').join(','),
        );
        expect(mismatched).toEqual([]);
      });

      it('keeps every <Trans> tag from en', () => {
        const mismatched = Object.keys(flatEn).filter(
          (key) => tags(flatEn[key]).join(',') !== tags(flat[key] ?? '').join(','),
        );
        expect(mismatched).toEqual([]);
      });
    });
  }
});
