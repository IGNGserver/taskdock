import react from '@vitejs/plugin-react';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [
    react(),
    {
      name: 'taskdock-precompressed-assets',
      apply: 'build',
      async writeBundle(options, bundle) {
        // Vite/PWA may still rewrite CSS URLs and inject registration code in
        // generateBundle. Compress only final bytes, not an earlier bundle view.
        for (const fileName of Object.keys(bundle)) {
          if (!/\.(?:js|css)$/.test(fileName)) continue;
          const path = resolve(options.dir ?? 'dist', fileName);
          const bytes = await readFile(path);
          if (bytes.byteLength < 1024) continue;
          await Promise.all([
            writeFile(`${path}.gz`, gzipSync(bytes)),
            writeFile(
              `${path}.br`,
              brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
            ),
          ]);
        }
      },
    },
    VitePWA({
      registerType: 'prompt',
      devOptions: {
        enabled: true,
      },
      includeAssets: [
        'favicon.png',
        'pwa-64.png',
        'pwa-180.png',
        'pwa-192.png',
        'pwa-512.png',
        'pwa-maskable-192.png',
        'pwa-maskable-512.png',
        'apple-touch-icon.png',
        'apple-touch-icon-180x180.png',
        'apple-touch-icon-167x167.png',
        'apple-touch-icon-152x152.png',
        'apple-touch-icon-120x120.png',
      ],
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
          { src: '/pwa-64.png', sizes: '64x64', type: 'image/png', purpose: 'any' },
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: '今日待办',
            short_name: '今日',
            description: '查看今天的安排与待办任务',
            url: '/today',
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '新建任务',
            short_name: '新建',
            description: '快速创建并捕获一条新任务',
            url: '/today?action=new-task',
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '任务目录树',
            short_name: '目录',
            description: '浏览完整文件夹结构与任务清单',
            url: '/tree',
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: '工作流看板',
            short_name: '流程',
            description: '按阶段跟踪任务流动与交付',
            url: '/workflows',
            icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png}'],
        cleanupOutdatedCaches: true,
        // Core routes stay available offline; large optional surfaces are cached
        // when visited rather than competing with the first useful screen.
        globIgnores: ['**/WorkflowsPage-*.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'taskdock-hashed-assets-v1',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 64, maxAgeSeconds: 31_536_000, purgeOnQuotaError: true },
            },
          },
        ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/health(?:\/|$)/,
          /^\/version$/,
          /^\/assets(?:\/|$)/,
        ],
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
  build: {
    manifest: true,
    // Safari 15.4+ / iOS 15.4+ is the supported browser baseline. Keeping the
    // target explicit prevents new ES2022 syntax from silently breaking older
    // iPhones, which cannot recover from a parse error (the whole app stays
    // blank before React starts).
    target: 'safari15',
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('react/') ||
              id.includes('react-dom/') ||
              id.includes('react-router-dom/')
            ) {
              return 'vendor-react';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (id.includes('marked') || id.includes('dompurify')) {
              return 'vendor-content';
            }
            if (id.includes('dexie')) {
              return 'vendor-db';
            }
          }
        },
      },
    },
  },
});
