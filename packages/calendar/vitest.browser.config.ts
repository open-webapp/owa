import { defineConfig } from 'vitest/config';
import type {} from '@vitest/browser/providers/playwright';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { include: ['react/jsx-dev-runtime', 'react', 'react-dom/client'] },
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['src/react/__tests__/*.browser.test.tsx'],
    browser: {
      enabled: true,
      provider: 'playwright',
      name: 'chromium',
      headless: true,
      screenshotFailures: false,
      viewport: { width: 1000, height: 900 },
      commands: {
        async scheme({ page }, value: 'light' | 'dark') {
          await page.emulateMedia({ colorScheme: value });
        },
      },
    },
  },
});
