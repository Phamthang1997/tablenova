/// <reference types="vite/client" />

/**
 * Build-time configuration. Declared explicitly rather than left to `vite/client`'s index signature
 * so a typo in a variable name is a compile error instead of `undefined` at runtime — which, for the
 * OAuth client below, would surface as Google's `invalid_client` page and nothing else.
 */
interface ImportMetaEnv {
  /** Google OAuth "installed app" client id. Unset in the repo — see `.env.example`. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Its client secret. Not confidential for an installed app (PKCE is), but still not checked in. */
  readonly VITE_GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'monaco-sql-languages/esm/*' {
  const content: any;
  export default content;
}
