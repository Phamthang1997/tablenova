import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
/**
 * Connects the standalone React DevTools (`npx react-devtools`) to the app, for profiling.
 *
 * Three things this shape buys over pasting `<script src="http://localhost:8097">` into index.html,
 * which is what was done first and had to be remembered and removed by hand before every build:
 *
 * - `apply: 'serve'` means it CANNOT reach a production build. index.html stays clean.
 * - It is off unless asked for, so nobody gets a failed request to localhost:8097 on every reload.
 *   Turn it on in the app's own DevTools console with `localStorage.rdt = 1`, then reload; turn it
 *   off with `localStorage.removeItem('rdt')`.
 * - `document.write` rather than appending a script element, deliberately. React DevTools works by
 *   installing a global hook that React looks for AS IT INITIALISES; a dynamically appended script
 *   loads asynchronously and usually arrives after React has already started, which presents as
 *   "Waiting for React to connect" and no amount of reloading fixes it. `document.write` during the
 *   initial parse is synchronous, which is the property needed here.
 *
 * Why the standalone tool and not a browser extension: this runs in WebView2, which has none.
 */
const reactDevtools = {
  name: 'react-devtools-standalone',
  apply: 'serve' as const,
  transformIndexHtml() {
    return [
      {
        tag: 'script',
        injectTo: 'head-prepend' as const,
        children:
          `try{if(localStorage.getItem('rdt')==='1')` +
          `document.write('<scr'+'ipt src="http://localhost:8097"></scr'+'ipt>')}catch(e){}`,
      },
    ];
  },
};

export default defineConfig({
  plugins: [react({}), reactDevtools],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src')
    }
  },
  clearScreen: false,
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@monaco-editor/react',
      'monaco-editor',
      'monaco-sql-languages',
      'lucide-react',
      'sql-formatter',
      '@xterm/xterm',
      '@xterm/addon-fit'
    ]
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    warmup: {
      clientFiles: ['./src/main.tsx', './src/App.tsx', './src/index.css']
    },
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/src-tauri/gen/**',
        '**/*.db*',
        '**/*.sqlite*',
        '**/*.dump',
        '**/*.gz',
        '**/*.sql'
      ]
    }
  },
  // Production build only — `vite build` (i.e. `npm run build-frontend`, which is Tauri's
  // beforeBuildCommand) reads this; the dev server does not. Deliberately no `esbuild`/`oxc`
  // block here: those are transform-level options that apply to dev too, and Vite 8 ships
  // rolldown with no esbuild installed, so `drop: ['console']` would be dead config anyway.
  build: {
    // WebView2 and WKWebView both ship a modern engine, so nothing needs down-levelling
    // and no polyfill has to be paid for in the installed app.
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vite 8 bundles with rolldown, where `manualChunks` is deprecated and its object
        // form is not supported at all (it would be silently ignored). `codeSplitting.groups`
        // is the supported spelling; `test` matches module ids. Splitting the heavy vendors
        // out keeps the entry chunk from being one ~6MB file the webview has to parse before
        // the first frame.
        codeSplitting: {
          groups: [
            // MUST stay first. `__vitePreload` exists only because SqlEditor/Console are lazy,
            // and rolldown otherwise parks that ~1kB helper inside whichever big group chunk it
            // feels like. The entry calls it, so the entry then statically imports that chunk —
            // which pulled all 4MB of Monaco back into startup and silently undid the lazy split.
            // Giving it its own chunk is what keeps the heavy groups reachable only on demand.
            { name: 'vite-helpers', test: /vite[/\\]preload-helper/ },
            { name: 'react-vendor', test: /node_modules[/](react|react-dom|scheduler|i18next|react-i18next)[/]/ },
            { name: 'monaco', test: /node_modules[/](monaco-editor|@monaco-editor)[/]/ },
            { name: 'sql-vendor', test: /node_modules[/](monaco-sql-languages|dt-sql-parser|sql-formatter)[/]/ },
            { name: 'xterm-vendor', test: /node_modules[/]@xterm[/]/ },
          ],
        },
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/utils/**/*.ts', 'src/sql/**/*.ts']
    }
  }
})
