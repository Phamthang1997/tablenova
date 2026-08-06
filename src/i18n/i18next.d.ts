import type en from './locales/en';

/**
 * Makes `t()` key-aware: `t('sidebar.noTables')` type-checks, while a typo like
 * `t('sidebar.noTable')` is a compile error instead of the UI rendering the raw
 * key string at runtime.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }
}
