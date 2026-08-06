import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en';
import vi from './locales/vi';
import ja from './locales/ja';

/**
 * i18next bootstrap. Imported for its side effect from `main.tsx`, which is the
 * entry point for both the main window and the standalone terminal window
 * (`?term=`), so a single import covers every window.
 */

/** localStorage key. Follows the `tf_*` convention already used by `tf_theme`. */
export const LANGUAGE_STORAGE_KEY = 'tf_lang';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', labelKey: 'language.en', flag: '🇬🇧' },
  { code: 'vi', labelKey: 'language.vi', flag: '🇻🇳' },
  { code: 'ja', labelKey: 'language.ja', flag: '🇯🇵' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** Resolves the two-letter code out of whatever i18next currently reports (`ja-JP` -> `ja`). */
export function currentLanguage(): LanguageCode {
  const base = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];
  return (SUPPORTED_LANGUAGES.find((l) => l.code === base)?.code ?? 'en') as LanguageCode;
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Dictionaries are bundled, not fetched: the app must work fully offline
    // (same reason the fonts are vendored in public/fonts). Three languages add
    // only a few KB, so there is nothing to lazy-load.
    resources: {
      en: { translation: en },
      vi: { translation: vi },
      ja: { translation: ja },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
    // Lets a browser locale like `ja-JP` or `vi-VN` resolve to `ja` / `vi`
    // instead of dropping straight to the fallback.
    nonExplicitSupportedLngs: true,
    detection: {
      // Only these two. The defaults also probe querystring and cookie, and the
      // app already uses a query param of its own (`?term=`) for the terminal
      // window, so keep URL parsing out of language selection.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    // React already escapes interpolated values.
    interpolation: { escapeValue: false },
    // Resources are synchronous, so there is nothing to suspend on.
    react: { useSuspense: false },
  });

// Keep <html lang> in sync so the browser picks the right CJK font variant and
// line-breaking rules for the active language.
const applyDocumentLang = (lng: string) => {
  if (typeof document !== 'undefined') document.documentElement.lang = lng.split('-')[0];
};
applyDocumentLang(i18n.resolvedLanguage || i18n.language || 'en');
i18n.on('languageChanged', applyDocumentLang);

export default i18n;
