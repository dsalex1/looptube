<script setup lang="ts">
const PATHS: Record<string, string> = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  start: 'M6 5h2v14H6zm12 0v14l-9-7z',
  back: 'M11 5v14l-9-7zm11 0v14l-9-7z',
  forward: 'M13 5v14l9-7zM2 5v14l9-7z',
  flag: 'M5 3v18h2v-7h12l-3-4 3-4H7V3z',
  prev: 'M7 6h2v12H7zm11 0v12l-8-6z',
  next: 'M15 6h2v12h-2zM6 6v12l8-6z',
  video: 'M4 6h11a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2zm14 4l4-3v10l-4-3z',
  wave: 'M2 12h3l2-7 3 14 3-11 2 6 2-3h5',
  link: 'M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.8 1.7M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.8-1.7',
  gear: 'M12 8a4 4 0 100 8 4 4 0 000-8zm9 4l2 2-2 4-3-1-2 1-1 3h-4l-1-3-2-1-3 1-2-4 2-2-2-2 2-4 3 1 2-1 1-3h4l1 3 2 1 3-1 2 4z',
  close: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zm0 4v5l3.5 2',
  mic: 'M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4',
  guitar: 'M7.5 12.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM12 10.5a3 3 0 100 6 3 3 0 000-6zM14.2 11.3l4.3-4.3M17.9 5.6l2-2 2.5 2.5-2 2z',
  drum: 'M4 9c0-2.2 3.6-4 8-4s8 1.8 8 4-3.6 4-8 4-8-1.8-8-4zM4 9v6c0 2.2 3.6 4 8 4s8-1.8 8-4V9',
  download: 'M12 3v11m0 0l-4-4m4 4l4-4M4 19h16',
  note: 'M9 18V6l11-2v10M9 18a2 2 0 11-4 0 2 2 0 014 0zm11-2a2 2 0 11-4 0 2 2 0 014 0z',
}
defineProps<{ name: keyof typeof PATHS | string; stroke?: boolean }>()
</script>

<template>
  <svg viewBox="0 0 24 24" aria-hidden="true" :fill="stroke ? 'none' : 'currentColor'"
    :stroke="stroke ? 'currentColor' : 'none'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path :d="PATHS[name]" />
  </svg>
</template>

<style scoped>
svg { width: 1.15em; height: 1.15em; display: block; }
</style>
