import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/callback': {
        target: 'https://open-webapp.duckdns.org',
        changeOrigin: true,
        headers: { Origin: 'https://open-webapp.github.io' },
      },
    },
  },
});
