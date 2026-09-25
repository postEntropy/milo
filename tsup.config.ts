import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'bin/cli': 'src/bin/cli.ts',
    'bin/serve': 'src/bin/serve.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,
})
