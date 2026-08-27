<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import type { StemPhase } from '@/helpers/stems'
import { computed } from 'vue'

const props = defineProps<{
  names: string[]
  volume: Record<string, number>
  phase: StemPhase | ''
}>()

defineEmits<{ setVolume: [name: string, value: number]; mute: [name: string] }>()

// a stem's own glyph, and a readable name; `other` is everything the four named stems left
const ICONS: Record<string, string> = { vocals: 'mic', guitars: 'guitar', bass: 'note', drums: 'drum', other: 'wave' }
const LABELS: Record<string, string> = { vocals: 'Vocals', guitars: 'Guitar', bass: 'Bass', drums: 'Drums', other: 'Other' }
const icon = (n: string) => ICONS[n] ?? 'wave'
const label = (n: string) => LABELS[n] ?? n

const working = computed(() => props.phase === 'separating' || props.phase === 'downloading')
const status = computed(() => (props.phase === 'downloading' ? 'Loading stems…' : 'Separating stems…'))
</script>

<template>
  <div v-if="working || names.length" class="mixer">
    <div v-if="!names.length" class="working"><span class="spin" />{{ status }}</div>
    <div v-for="name in names" :key="name" class="row" :class="{ off: (volume[name] ?? 1) === 0 }">
      <button class="lbl" :title="(volume[name] ?? 1) === 0 ? `Unmute ${label(name)}` : `Mute ${label(name)}`" @click="$emit('mute', name)">
        <Icon :name="icon(name)" stroke />
        <span>{{ label(name) }}</span>
      </button>
      <input
        class="fader"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="volume[name] ?? 1"
        :aria-label="`${label(name)} volume`"
        @input="$emit('setVolume', name, +($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.mixer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  background: #0d0d0d;
  border-top: 1px solid #1e1e1e;
}
.row { display: flex; align-items: center; gap: 12px; }
.lbl {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 96px;
  flex: none;
  padding: 0;
  background: none;
  border: 0;
  color: #d7d7d7;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.lbl svg { color: #e8bd6d; }
.row.off .lbl { color: #5f5f5f; }
.row.off .lbl svg { color: #5f5f5f; }
.fader {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #2a2a2a;
  border-radius: 999px;
  outline: none;
  cursor: pointer;
}
/* the filled part reads as the level; both engines need their own thumb rule */
.fader::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #f2f2f2;
  border: 0;
  cursor: pointer;
}
.fader::-moz-range-thumb {
  width: 15px;
  height: 15px;
  border: 0;
  border-radius: 50%;
  background: #f2f2f2;
  cursor: pointer;
}
.row.off .fader::-webkit-slider-thumb { background: #666; }
.row.off .fader::-moz-range-thumb { background: #666; }
.working { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8f8f8f; }
.spin {
  width: 12px;
  height: 12px;
  border: 2px solid #333;
  border-top-color: #e8bd6d;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
