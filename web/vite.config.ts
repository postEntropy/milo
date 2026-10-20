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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // One file per dependency family rather than one bundle: the runtime a version bump
        // never touches stays cached while the app is rebuilt, and no single file crosses
        // the size Rollup warns about. Everything still loads with the first screen.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('react') || id.includes('scheduler')) return 'react'
          if (id.includes('marked') || id.includes('dompurify')) return 'markdown'
          return 'vendor'
        },
      },
    },
  },
})
