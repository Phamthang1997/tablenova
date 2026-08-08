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
