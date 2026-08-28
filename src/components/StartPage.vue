<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import RecentGrid from '@/components/RecentGrid.vue'
import type { Recent } from '@/helpers/recents'
import { ref } from 'vue'

defineProps<{ items: Recent[]; offline: Set<string>; error: string }>()
const emit = defineEmits<{
  (e: 'submit', raw: string): void
  (e: 'open', id: string): void
  (e: 'forget', id: string): void
  (e: 'file', file: File): void
}>()

const raw = ref('')
const picker = ref<HTMLInputElement>()
const dragging = ref(false)

function chooseFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) emit('file', file)
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) emit('file', file)
}
</script>

<template>
  <div
    class="start"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="hero">
      <Icon name="wave" stroke />
      <h1>Loop any YouTube video</h1>
      <p>A–B repeat, markers, tempo and pitch, against a real waveform.</p>

      <form class="find" @submit.prevent="emit('submit', raw)">
        <input
          v-model="raw"
          type="url"
          inputmode="url"
          placeholder="Paste a YouTube link…"
          spellcheck="false"
          autocomplete="off"
          autofocus
        />
        <button type="submit" class="go">Load</button>
      </form>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="or"><span>or</span></div>

      <input ref="picker" type="file" accept="audio/*,video/*" hidden @change="chooseFile" />
      <button class="file" @click="picker?.click()">
        <Icon name="video" />
        Open an audio file
      </button>
      <p class="hint">Drop one anywhere on this page. It never leaves your device.</p>
    </div>

    <section v-if="items.length" class="recent">
      <h2>Recent</h2>
      <RecentGrid :items="items" :offline="offline" @open="emit('open', $event)" @forget="emit('forget', $event)" />
    </section>
  </div>
</template>

<style scoped>
.start {
  flex: 1;
  overflow-y: auto;
  padding: 28px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 34px;
  align-items: center;
}
.start.dragging { outline: 2px dashed #f59e0b; outline-offset: -10px; }
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  width: 100%;
  max-width: 560px;
}
.hero > svg { width: 42px; height: 42px; color: #f59e0b; }
h1 { margin: 0; font-size: 22px; font-weight: 600; color: #f0f0f0; }
.hero p { margin: 0; font-size: 14px; line-height: 1.5; color: #8a8a8a; }
.find { display: flex; gap: 8px; width: 100%; margin-top: 6px; }
.find input {
  flex: 1;
  min-width: 0;
  height: 42px;
  padding: 0 14px;
  background: #151515;
  border: 1px solid #303030;
  border-radius: 9px;
  color: #ececec;
  font-size: 15px;
}
.find input:focus { outline: none; border-color: #f59e0b; }
.go {
  height: 42px;
  padding: 0 20px;
  background: #f59e0b;
  color: #101010;
  border: 0;
  border-radius: 9px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
}
.error { color: #d98b8b; font-size: 13px; }
.or {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  color: #5f5f5f;
  font-size: 12px;
}
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: #242424; }
.file {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 16px;
  background: #1a1a1a;
  border: 1px solid #303030;
  border-radius: 9px;
  color: #dcdcdc;
  font-size: 14px;
  cursor: pointer;
}
.file:hover { background: #242424; border-color: #3d3d3d; }
.hint { font-size: 12px; color: #6b6b6b; }
.recent { width: 100%; max-width: 1000px; }
h2 {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b6b6b;
}
</style>
