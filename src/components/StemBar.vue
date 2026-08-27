<script setup lang="ts">
import type { StemPhase } from '@/helpers/stems'
import { computed } from 'vue'

const props = defineProps<{
  names: string[]
  muted: Record<string, boolean>
  phase: StemPhase | ''
}>()

defineEmits<{ toggle: [name: string] }>()

const working = computed(() => props.phase === 'separating' || props.phase === 'downloading')
const label = computed(() => (props.phase === 'downloading' ? 'Loading stems…' : 'Separating stems…'))
</script>

<template>
  <div v-if="working || names.length" class="stems">
    <span class="tag">Stems</span>
    <template v-if="names.length">
      <button
        v-for="name in names"
        :key="name"
        class="stem"
        :class="{ off: muted[name] }"
        :aria-pressed="!muted[name]"
        :title="muted[name] ? `Unmute ${name}` : `Mute ${name}`"
        @click="$emit('toggle', name)"
      >
        {{ name }}
      </button>
    </template>
    <span v-else class="working">{{ label }}</span>
  </div>
</template>

<style scoped>
.stems {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 7px 10px;
  background: #0d0d0d;
  border-top: 1px solid #1e1e1e;
}
.tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b6b6b;
}
.stem {
  height: 28px;
  padding: 0 12px;
  background: #e8bd6d;
  color: #101010;
  border: 1px solid #e8bd6d;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  text-transform: capitalize;
  cursor: pointer;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}
/* muted reads as switched off: hollow and dimmed, still clearly a control */
.stem.off {
  background: transparent;
  color: #6f6f6f;
  border-color: #333;
}
.working { font-size: 12px; color: #8f8f8f; }
</style>
