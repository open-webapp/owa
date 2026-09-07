import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// React de-duplication for the test runner.
//
// This package targets React 19 (peerDependency) and ships a 19 copy under its
// own `node_modules`, but a React 18 is also hoisted to the workspace root.
// Under vitest, `@testing-library/react` / `react-dom` are externalized and
// Node-resolved (→ the hoisted root copy), while transformed source files load
// the local copy. Two React instances in one render throw "Objects are not
// valid as a React child". `resolve.alias` only reaches the transformed source
// (not the externalized deps), so the only way to get a single instance is to
// point the source at the same copy the externalized deps use: the hoisted
// root one. The component under test uses only stable hooks (`useEffect`,
// `useSyncExternalStore`), identical across 18/19, so this is test-runner
// plumbing only — the shipped build still compiles against React 19.
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
  },
})
