import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@protocol': fileURLToPath(new URL('../src/gateways/web/protocol.ts', import.meta.url)),
      '@theme': fileURLToPath(new URL('../src/gateways/cli/theme.ts', import.meta.url)),
    },
  },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:7717', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7717', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
