import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// GitHub Pages serves this repo from /docs on the project path, so assets need that base
export default defineConfig({
  base: process.env.PAGES_BASE ?? '/looptube/',
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'docs', emptyOutDir: true },
  test: { environment: 'happy-dom' },
})
