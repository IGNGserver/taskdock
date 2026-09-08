import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'TaskDock 开发任务工作台',
        short_name: 'TaskDock',
        description: '个人开发工作的离线优先任务工作台',
        lang: 'zh-CN',
        start_url: '/today',
        display: 'standalone',
        theme_color: '#f5f6f8',
        background_color: '#f5f6f8',
        icons: [
          { src: '/pwa-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: '/pwa-512.svg', sizes: '512x512', type: 'image/svg+xml' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,ico}'], navigateFallback: '/index.html' },
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
