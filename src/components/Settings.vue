<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { DEFAULT_SERVICE, serviceUrl, setServiceUrl } from '@/helpers/peaksSource'
import { ref } from 'vue'

defineProps<{ hasRealAudio: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const service = ref(serviceUrl())
const build = __BUILD__

function saveService() {
  setServiceUrl(service.value)
  emit('close')
}
</script>

<template>
  <div class="scrim" @click.self="emit('close')">
    <div class="sheet">
      <header>
        <h2>Settings</h2>
        <button class="icon" aria-label="Close" @click="emit('close')"><Icon name="close" stroke /></button>
      </header>

      <section>
        <h3>Audio source</h3>
        <p class="note" :class="{ 'note--ok': hasRealAudio }">
          {{ hasRealAudio ? 'Real audio loaded — waveform, pitch and boost are live.' : 'No audio yet: the waveform is a flat bed and pitch is off.' }}
        </p>
        <p class="why">
          YouTube serves media over SABR, so a browser cannot read the stream itself. A small proxy resolves it and
          relays the bytes; your browser does the decoding.
        </p>
        <label>Proxy URL</label>
        <input v-model="service" type="url" spellcheck="false" autocomplete="off" />
        <div class="actions">
          <button class="btn" @click="service = DEFAULT_SERVICE">Reset to default</button>
          <button class="btn btn--primary" @click="saveService">Save</button>
        </div>
      </section>

      <p class="build">Build {{ build }}</p>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 50;
}
.sheet {
  width: min(100%, 520px);
  max-height: 88vh;
  overflow: auto;
  background: #121212;
  border: 1px solid #2c2c2c;
  border-radius: 12px;
  padding: 16px 18px 20px;
  color: #dcdcdc;
}
header { display: flex; align-items: center; justify-content: space-between; }
h2 { margin: 0; font-size: 17px; }
h3 { margin: 0 0 6px; font-size: 14px; color: #f59e0b; }
section { margin-top: 18px; }
label { display: block; font-size: 12px; color: #8f8f8f; margin-bottom: 5px; }
input[type='url'] {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  background: #1a1a1a;
  border: 1px solid #2e2e2e;
  border-radius: 7px;
  color: #ececec;
  font-size: 13px;
}
.note { margin: 0 0 8px; font-size: 13px; color: #c98b8b; }
.note--ok { color: #7fc98b; }
.why { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: #8a8a8a; }
.actions { display: flex; gap: 8px; margin-top: 10px; }
.btn {
  height: 34px;
  padding: 0 13px;
  background: #1e1e1e;
  border: 1px solid #333;
  border-radius: 7px;
  color: #dcdcdc;
  font-size: 13px;
  cursor: pointer;
}
.btn--primary { background: #f59e0b; border-color: #f59e0b; color: #101010; font-weight: 600; }
.icon {
  display: flex;
  width: 30px;
  height: 30px;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  color: #9a9a9a;
  cursor: pointer;
}
.build { margin: 20px 0 0; font-size: 11px; color: #5c5c5c; text-align: right; font-variant-numeric: tabular-nums; }
</style>
