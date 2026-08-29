<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import { stemIcon, stemLabel } from '@/helpers/stems'

defineProps<{ names: string[]; volume: Record<string, number> }>()

defineEmits<{ setVolume: [name: string, value: number]; mute: [name: string] }>()
</script>

<template>
  <div class="mixer">
    <div v-for="name in names" :key="name" class="row" :class="{ off: (volume[name] ?? 1) === 0 }">
      <button
        class="lbl"
        :title="(volume[name] ?? 1) === 0 ? `Unmute ${stemLabel(name)}` : `Mute ${stemLabel(name)}`"
        @click="$emit('mute', name)"
      >
        <Icon :name="stemIcon(name)" stroke />
        <span>{{ stemLabel(name) }}</span>
      </button>
      <input
        class="fader"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="volume[name] ?? 1"
        :aria-label="`${stemLabel(name)} volume`"
        @input="$emit('setVolume', name, +($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.mixer { display: flex; flex-direction: column; gap: 7px; }
.row { display: flex; align-items: center; gap: 9px; }
.lbl {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 70px;
  flex: none;
  padding: 0;
  background: none;
  border: 0;
  color: #d7d7d7;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.lbl svg { color: #f59e0b; }
.row.off .lbl,
.row.off .lbl svg { color: #5f5f5f; }
.row.off .lbl span { text-decoration: line-through; }
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
</style>
