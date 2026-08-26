<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import JogStrip from '@/components/JogStrip.vue'
import type { Capabilities, PaneView } from '@/types'
import { computed } from 'vue'

const props = defineProps<{
  can: Capabilities
  playing: boolean
  currentTime: number
  duration: number
  markerAtPlayhead: boolean
  hasLoop: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle' | 'toStart' | 'marker' | 'clearLoop'): void
  (e: 'skip', seconds: number): void
  (e: 'jumpMarker', direction: -1 | 1): void
  (e: 'setLoop', which: 'a' | 'b'): void
  (e: 'nudgeLoop', direction: -1 | 1): void
  (e: 'scaleLoop', factor: number): void
}>()

const tempo = defineModel<number>('tempo', { required: true })
const pitch = defineModel<number>('pitch', { required: true })
const gainDb = defineModel<number>('gainDb', { required: true })
const view = defineModel<PaneView>('view', { required: true })
const loopOpen = defineModel<boolean>('loopOpen', { required: true })

const SKIP = 10
const MAX_PITCH = 12
const GAIN_LIMIT = 20

const stamp = (seconds: number) => {
  const safe = Math.max(0, seconds || 0)
  const tenths = Math.floor((safe % 1) * 10)
  return `${Math.floor(safe / 60)}:${String(Math.floor(safe % 60)).padStart(2, '0')}.${tenths}`
}

// YouTube accepts only a fixed ladder of rates, so the jog lands on the nearest rung
// instead of sliding through values the player would silently ignore
const steps = computed(() => props.can.tempoSteps)
const tempoRange = computed(() => {
  const ladder = steps.value
  return ladder ? { step: 0.25, min: ladder[0], max: ladder[ladder.length - 1] } : { step: 0.01, min: 0.25, max: 4 }
})

function adjustTempo(delta: number) {
  const ladder = steps.value
  if (!ladder) {
    tempo.value = Math.round(Math.max(0.25, Math.min(4, tempo.value + delta)) * 100) / 100
    return
  }
  const nearest = ladder.reduce((b, r) => (Math.abs(r - tempo.value) < Math.abs(b - tempo.value) ? r : b), ladder[0])
  const i = ladder.indexOf(nearest)
  tempo.value = ladder[Math.max(0, Math.min(ladder.length - 1, i + Math.sign(delta)))]
}

const adjustPitch = (d: number) => (pitch.value = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.round(pitch.value) + d)))
const adjustGain = (d: number) =>
  (gainDb.value =
    Math.round(Math.max(-GAIN_LIMIT, Math.min(props.can.boost ? GAIN_LIMIT : 0, gainDb.value + d)) * 100) / 100)
const signed = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2))

const pitchHint = computed(() =>
  props.can.pitch ? 'Drag to shift pitch in semitones' : 'YouTube playback cannot shift pitch — load the audio to enable it'
)
</script>

<template>
  <div class="controls">
    <!-- A-B repeat: shown on demand, because hiding it is also what turns the loop off -->
    <div v-if="loopOpen" class="loopbar">
      <span class="cap">A–B repeat</span>
      <button class="btn" @click="emit('setLoop', 'a')">Set A</button>
      <button class="btn" @click="emit('setLoop', 'b')">Set B</button>
      <span class="sep" />
      <button class="btn" :disabled="!hasLoop" title="Nudge earlier" @click="emit('nudgeLoop', -1)">◀</button>
      <button class="btn" :disabled="!hasLoop" title="Nudge later" @click="emit('nudgeLoop', 1)">▶</button>
      <button class="btn" :disabled="!hasLoop" title="Halve the loop" @click="emit('scaleLoop', 0.5)">½</button>
      <button class="btn" :disabled="!hasLoop" title="Double the loop" @click="emit('scaleLoop', 2)">×2</button>
      <button class="btn btn--quiet" :disabled="!hasLoop" @click="emit('clearLoop')">Clear</button>
    </div>

    <!-- one line, always: elapsed | transport | remaining and the view switch -->
    <div class="primary">
      <span class="stamp">{{ stamp(currentTime) }}</span>

      <div class="transport">
        <button class="btn" aria-label="Back to start" @click="emit('toStart')"><Icon name="start" /></button>
        <button class="btn" aria-label="Back 10 seconds" @click="emit('skip', -SKIP)"><Icon name="back" /></button>
        <button class="btn btn--play" :aria-label="playing ? 'Pause' : 'Play'" @click="emit('toggle')">
          <Icon :name="playing ? 'pause' : 'play'" />
        </button>
        <button class="btn" aria-label="Forward 10 seconds" @click="emit('skip', SKIP)"><Icon name="forward" /></button>
        <button class="btn btn--wide" :class="{ 'btn--on': loopOpen }" aria-label="A-B repeat" @click="loopOpen = !loopOpen">
          A–B
        </button>
      </div>

      <div class="tail">
        <span class="stamp stamp--right">−{{ stamp(Math.max(0, duration - currentTime)) }}</span>
        <div class="views">
          <button
            class="btn"
            :class="{ 'btn--on': view === 'video' }"
            aria-label="Video"
            title="Video"
            @click="view = 'video'"
          >
            <Icon name="video" />
          </button>
          <button
            class="btn"
            :class="{ 'btn--on': view === 'waveform' }"
            aria-label="Waveform"
            title="Waveform"
            @click="view = 'waveform'"
          >
            <Icon name="wave" stroke />
          </button>
        </div>
      </div>
    </div>

    <!-- the dials scroll sideways rather than wrapping into ragged rows -->
    <div class="dials">
      <div class="dial">
        <span class="cap">Markers</span>
        <div class="dial__row">
          <button class="btn" aria-label="Previous marker" @click="emit('jumpMarker', -1)"><Icon name="prev" /></button>
          <button
            class="btn"
            :class="{ 'btn--on': markerAtPlayhead }"
            :aria-label="markerAtPlayhead ? 'Remove marker' : 'Add marker'"
            @click="emit('marker')"
          >
            <Icon name="flag" />
          </button>
          <button class="btn" aria-label="Next marker" @click="emit('jumpMarker', 1)"><Icon name="next" /></button>
        </div>
      </div>

      <div class="dial">
        <span class="cap">Tempo</span>
        <div class="dial__row">
          <button class="btn btn--glyph" aria-label="Slower" @click="adjustTempo(-0.05)">−</button>
          <JogStrip v-model="tempo" v-bind="tempoRange" :resetTo="1" :label="`${tempo.toFixed(2)}x`" sub="rate" />
          <button class="btn btn--glyph" aria-label="Faster" @click="adjustTempo(0.05)">+</button>
        </div>
      </div>

      <div class="dial" :class="{ 'dial--off': !can.pitch }" :title="pitchHint">
        <span class="cap">Pitch</span>
        <div class="dial__row">
          <button class="btn btn--glyph" :disabled="!can.pitch" aria-label="Pitch down" @click="adjustPitch(-1)">♭</button>
          <JogStrip
            v-model="pitch"
            :step="0.01"
            :min="-MAX_PITCH"
            :max="MAX_PITCH"
            :resetTo="0"
            :label="signed(pitch)"
            sub="semi"
          />
          <button class="btn btn--glyph" :disabled="!can.pitch" aria-label="Pitch up" @click="adjustPitch(1)">♯</button>
        </div>
      </div>

      <div class="dial">
        <span class="cap">Level</span>
        <div class="dial__row">
          <button class="btn btn--glyph" aria-label="Quieter" @click="adjustGain(-0.5)">−</button>
          <JogStrip
            v-model="gainDb"
            :step="0.02"
            :min="-GAIN_LIMIT"
            :max="can.boost ? GAIN_LIMIT : 0"
            :resetTo="0"
            :label="`${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)}`"
            sub="dB"
          />
          <button
            class="btn btn--glyph"
            :disabled="!can.boost && gainDb >= 0"
            aria-label="Louder"
            @click="adjustGain(0.5)"
          >
            +
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.controls {
  background: #0d0d0d;
  border-top: 1px solid #242424;
  padding: 9px 10px calc(9px + env(safe-area-inset-bottom));
}

/* elapsed | transport | remaining+views, so the transport sits dead centre at any width */
.primary {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
}
.transport { display: flex; gap: 6px; }
.tail { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.views { display: flex; gap: 4px; }

.dials {
  display: flex;
  gap: 14px;
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px solid #1e1e1e;
  overflow-x: auto;
  scrollbar-width: none;
}
.dials::-webkit-scrollbar { display: none; }
.dial { display: flex; flex-direction: column; gap: 5px; flex: 0 0 auto; }
.dial__row { display: flex; align-items: center; gap: 4px; }
.dial--off { opacity: 0.4; }

.cap {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b6b6b;
}

.loopbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: 9px;
  margin-bottom: 9px;
  border-bottom: 1px solid #1e1e1e;
}
.loopbar .cap { margin-right: 4px; }
.sep { width: 1px; height: 20px; background: #2c2c2c; margin: 0 2px; }

.stamp { font-variant-numeric: tabular-nums; font-size: 13px; color: #9a9a9a; }
.stamp--right { text-align: right; }

.btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 34px;
  padding: 0 9px;
  background: #1a1a1a;
  color: #dcdcdc;
  border: 1px solid #2e2e2e;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn:hover:not(:disabled) { background: #262626; border-color: #3a3a3a; }
.btn:disabled { opacity: 0.32; cursor: default; }
.btn--on { background: #e8bd6d; border-color: #e8bd6d; color: #101010; }
.btn--quiet { color: #9a9a9a; }
.btn--wide { min-width: 46px; font-weight: 600; }
.btn--glyph { font-size: 16px; }
.btn--play {
  min-width: 54px;
  background: #e8bd6d;
  border-color: #e8bd6d;
  color: #101010;
}
.btn--play:hover:not(:disabled) { background: #f0cb85; border-color: #f0cb85; }

@media (max-width: 560px) {
  .stamp--right { display: none; }
  .tail { gap: 6px; }
}
</style>
