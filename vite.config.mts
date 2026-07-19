import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react({})],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/*.db', '**/*.sqlite', '**/*.dump', '**/*.gz', '**/*.sql']
    }
  },
  envPrefix: ['VITE_', 'TAURI_']
})
