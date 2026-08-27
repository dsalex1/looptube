import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves this repo from /docs on the project path, so assets need that base
const base = process.env.PAGES_BASE ?? '/looptube/'

export default defineConfig({
  base,
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'LoopTube',
        short_name: 'LoopTube',
        description: 'Loop any YouTube video against a real waveform',
        // Pages serves the app under a sub-path, so the scope has to say so or the
        // installed app opens at the domain root and finds nothing
        id: base,
        scope: base,
        start_url: base,
        display: 'standalone',
        orientation: 'any',
        background_color: '#050505',
        theme_color: '#050505',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // the player and the audio relay are both cross-origin and must stay live; only
        // the shell is worth precaching
        navigateFallbackDenylist: [/^\/looptube\/(audio|meta)/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/www\.youtube\.com\/iframe_api/,
            handler: 'NetworkFirst',
            options: { cacheName: 'yt-iframe-api', expiration: { maxAgeSeconds: 60 * 60 * 24 } },
          },
        ],
      },
    }),
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'docs', emptyOutDir: true },
  test: { environment: 'happy-dom' },
})
