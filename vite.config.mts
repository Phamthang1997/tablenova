import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react({})],
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
            { name: 'monaco', test: /node_modules[/](monaco-editor|@monaco-editor)[/]/ },
            { name: 'sql-vendor', test: /node_modules[/](monaco-sql-languages|dt-sql-parser|sql-formatter)[/]/ },
            { name: 'xterm-vendor', test: /node_modules[/]@xterm[/]/ },
            { name: 'react-vendor', test: /node_modules[/](react|react-dom|scheduler|i18next|react-i18next)[/]/ },
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
