import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// React de-duplication for the test runner (same rationale as
// packages/drive-connect/vitest.config.ts). This package targets React 19 and
// has a local 19 copy, but React 18 is hoisted at the workspace root and
// `@testing-library/react` / `react-dom` are externalized and Node-resolved to
// it. Two React instances in one render throw, so transformed source is aliased
// to the same hoisted root copy. Test-runner plumbing only; the shipped build
// still compiles against React 19. UI code must stick to hooks stable across
// 18/19 (useEffect, useSyncExternalStore, ...).
const shared = (p: string) =>
  fileURLToPath(new URL(`../../node_modules/${p}`, import.meta.url))

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react/jsx-dev-runtime': shared('react/jsx-dev-runtime.js'),
      'react/jsx-runtime': shared('react/jsx-runtime.js'),
      'react-dom/client': shared('react-dom/client.js'),
      'react-dom/test-utils': shared('react-dom/test-utils.js'),
      'react-dom': shared('react-dom/index.js'),
      react: shared('react/index.js'),
    },
  },
  esbuild: {
    target: 'esnext',
    jsx: 'automatic',
  },
})
