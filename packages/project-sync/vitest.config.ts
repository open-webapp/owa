import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/react/__tests__/setup.ts'],
  },
  esbuild: {
    target: 'esnext',
  },
})
