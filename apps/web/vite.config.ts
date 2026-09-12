import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.png', 'pwa-180.png', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        name: 'TaskDock 开发任务工作台',
        short_name: 'TaskDock',
        description: '个人开发工作的离线优先任务工作台',
        lang: 'zh-CN',
        id: '/',
        scope: '/',
        start_url: '/today',
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        categories: ['productivity', 'developer'],
        theme_color: '#f5f2f9',
        background_color: '#f5f2f9',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/health(?:\/|$)/, /^\/version$/],
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', ws: true },
      '/health': 'http://127.0.0.1:3000',
      '/version': 'http://127.0.0.1:3000',
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
