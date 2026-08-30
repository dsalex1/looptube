import vue from '@vitejs/plugin-vue'
import { execSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves this repo from /docs on the project path, so assets need that base
const base = process.env.PAGES_BASE ?? '/looptube/'

// a build stamp the running app can show, so "what am I on" has an answer. The commit
// count is the version: it only ever goes up, so two builds can be told apart at a glance
// in a way a hash cannot. Falls back to "dev" outside a git checkout.
// what the count was when the numbering was restarted at 7, so the shown version keeps
// stepping by one from there rather than from however many commits the repo happens to have
const VERSION_BASE = 28
const build = (() => {
  const day = new Date().toISOString().slice(0, 10)
  try {
    const count = Number(execSync('git rev-list --count HEAD').toString().trim())
    return `v${count - VERSION_BASE} · ${day}`
  } catch {
    return `dev · ${day}`
  }
})()

export default defineConfig({
  base,
  plugins: [
    vue(),
    VitePWA({
      // prompt, not autoUpdate: a silent swap gives the user no way to know a new build
      // landed, and an installed app may never close long enough for one to take over
      registerType: 'prompt',
      injectRegister: null, // useAppUpdate registers it, so it can hold the callbacks
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
        globIgnores: ['**/__test-*'], // the sync harness is not part of the app
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
  define: { __BUILD__: JSON.stringify(build) },
  // Signalsmith builds its worklet by stringifying its own source into a Blob, so anything
  // that lowers the class fields in it lowers them into `__publicField` helpers that do not
  // exist in worklet scope - the processor then dies on load and the node never becomes
  // ready. The dev dep optimiser does exactly that, so it is kept away from it. The
  // production build targets modern browsers and leaves the fields alone; if the build
  // target is ever lowered, check `__publicField` has not appeared in the bundle.
  optimizeDeps: { exclude: ['signalsmith-stretch'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'docs', emptyOutDir: true },
  test: { environment: 'happy-dom' },
})
