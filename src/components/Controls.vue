<script setup lang="ts">
import Icon from '@/components/Icon.vue'
import JogStrip from '@/components/JogStrip.vue'
import StemMixer from '@/components/StemMixer.vue'
import WaveformCanvas from '@/components/WaveformCanvas.vue'
import { stemIcon, stemLabel, type StemPhase } from '@/helpers/stems'
import type { Capabilities, PaneView } from '@/types'
import { onBeforeUnmount, onMounted, computed, ref } from 'vue'

const props = defineProps<{
  can: Capabilities
  playing: boolean
  currentTime: number
  duration: number
  markerAtPlayhead: boolean
  hasLoop: boolean
  /** the whole-track strip under the dials */
  peaks: Uint8Array
  markers: number[]
  loopA: number | null
  loopB: number | null
  /** the split of the track, if it has been split; the mixer hides behind one button */
  stemNames: string[]
  stemVolume: Record<string, number>
  stemPhase: StemPhase | ''
}>()

const emit = defineEmits<{
  (e: 'toggle' | 'toStart' | 'marker' | 'clearLoop'): void
  (e: 'skip', seconds: number): void
  (e: 'jumpMarker', direction: -1 | 1): void
  (e: 'setLoop', which: 'a' | 'b'): void
  (e: 'stepLoop', direction: -1 | 1): void
  (e: 'scaleLoop', factor: number): void
  (e: 'seek', seconds: number): void
  (e: 'setStemVolume', name: string, value: number): void
  (e: 'muteStem', name: string): void
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

// both sources take a continuous rate; they just reach different distances
const tempoRange = computed(() => ({ step: 0.01, min: props.can.tempoMin, max: props.can.tempoMax }))

const adjustTempo = (delta: number) =>
  (tempo.value =
    Math.round(Math.max(props.can.tempoMin, Math.min(props.can.tempoMax, tempo.value + delta)) * 100) / 100)

const adjustPitch = (d: number) => (pitch.value = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, Math.round(pitch.value) + d)))
const adjustGain = (d: number) =>
  (gainDb.value =
    Math.round(Math.max(-GAIN_LIMIT, Math.min(props.can.boost ? GAIN_LIMIT : 0, gainDb.value + d)) * 100) / 100)
const signed = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2))

/**
 * The mixer costs five rows of a screen that has none to spare, so it lives in a panel
 * that floats over the stage and the button that opens it carries the mix instead: one
 * glyph per stem, fading out as its fader comes down and struck through once it is muted.
 * That way the state that mattered is still on the bar when the panel is shut.
 */
const stemsOpen = ref(false)
const stems = ref<HTMLElement>()
const splitting = computed(() => !props.stemNames.length)
const stemsShown = computed(() => props.stemPhase !== '' || props.stemNames.length > 0)

const stemHint = computed(() => {
  if (props.stemPhase === 'failed') return 'Could not split this track into stems'
  if (splitting.value) return props.stemPhase === 'downloading' ? 'Loading stems…' : 'Separating stems…'
  const muted = props.stemNames.filter((n) => (props.stemVolume[n] ?? 1) === 0).map(stemLabel)
  return muted.length ? `Stems — ${muted.join(', ')} muted` : 'Stems — all playing'
})

const level = (name: string) => props.stemVolume[name] ?? 1

function closeStems(e: Event) {
  if (!stems.value?.contains(e.target as Node)) stemsOpen.value = false
}

const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && (stemsOpen.value = false)

onMounted(() => {
  document.addEventListener('pointerdown', closeStems)
  window.addEventListener('keydown', onEscape)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeStems)
  window.removeEventListener('keydown', onEscape)
})

const pitchHint = computed(() =>
  props.can.pitch ? 'Drag to shift pitch in semitones' : 'YouTube playback cannot shift pitch — load the audio to enable it'
)
</script>

<template>
  <div class="controls">
    <!-- tempo, markers, pitch and level, flanked by elapsed / remaining -->
    <div class="row">
      <span class="stamp">{{ stamp(currentTime) }}</span>

      <div class="group">
        <button class="btn btn--glyph" aria-label="Slower" @click="adjustTempo(-0.05)">−</button>
        <JogStrip v-model="tempo" v-bind="tempoRange" :resetTo="1" :label="`${tempo.toFixed(2)}x`" sub="rate" />
        <button class="btn btn--glyph" aria-label="Faster" @click="adjustTempo(0.05)">+</button>
      </div>

      <div class="group">
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

      <div class="group" :class="{ 'group--off': !can.pitch }" :title="pitchHint">
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

      <div class="group">
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
        <button class="btn btn--glyph" :disabled="!can.boost && gainDb >= 0" aria-label="Louder" @click="adjustGain(0.5)">
          +
        </button>
      </div>

      <span class="stamp stamp--right">−{{ stamp(Math.max(0, duration - currentTime)) }}</span>
    </div>

    <!-- the whole track at a glance: tap anywhere to seek, no handles to grab -->
    <div class="overview">
      <WaveformCanvas
        overview
        :peaks="peaks"
        :duration="duration"
        :start="0"
        :end="duration"
        :markers="markers"
        :loopA="loopA"
        :loopB="loopB"
        :loopActive="loopOpen"
        :position="currentTime"
        @seek="emit('seek', $event)"
      />
    </div>

    <!-- A-B repeat: shown on demand, because hiding it is also what turns the loop off -->
    <div v-if="loopOpen" class="row row--loop">
      <div class="group">
        <button class="btn" :class="{ 'btn--on': loopA != null }" @click="emit('setLoop', 'a')">A</button>
        <button class="btn" aria-label="Clear A-B" :disabled="!hasLoop" @click="emit('clearLoop')">
          <Icon name="close" stroke />
        </button>
        <button class="btn" :class="{ 'btn--on': loopB != null }" @click="emit('setLoop', 'b')">B</button>
      </div>

      <div class="group">
        <button class="btn" :disabled="!hasLoop" aria-label="Step back one selection" @click="emit('stepLoop', -1)">◀</button>
        <button class="btn" :disabled="!hasLoop" aria-label="Step forward one selection" @click="emit('stepLoop', 1)">▶</button>
        <button class="btn" :disabled="!hasLoop" aria-label="Halve the loop" @click="emit('scaleLoop', 0.5)">½</button>
        <button class="btn" :disabled="!hasLoop" aria-label="Double the loop" @click="emit('scaleLoop', 2)">x2</button>
      </div>
    </div>

    <!-- transport, with what is playing on the left and what is shown on the right -->
    <div class="row">
      <div class="group group--side">
        <button class="btn" :class="{ 'btn--on': loopOpen }" aria-label="A-B repeat" @click="loopOpen = !loopOpen">
          A–B
        </button>

        <!-- the mix, small enough to ride the transport row: one glyph per stem, dimming
             with its fader and struck through once it is muted -->
        <div v-if="stemsShown" ref="stems" class="stems">
          <button
            class="btn btn--stems"
            :class="{ 'btn--stems-open': stemsOpen }"
            :disabled="splitting"
            :title="stemHint"
            :aria-label="stemHint"
            :aria-expanded="stemsOpen"
            @click="stemsOpen = !stemsOpen"
          >
            <span v-if="splitting" class="spin" />
            <template v-else>
              <span
                v-for="name in stemNames"
                :key="name"
                class="glyph"
                :class="{ 'glyph--off': level(name) === 0 }"
                :style="{ opacity: level(name) === 0 ? 1 : 0.3 + 0.7 * level(name) }"
              >
                <Icon :name="stemIcon(name)" stroke />
              </span>
            </template>
          </button>

          <!-- floated over the stage rather than stacked into the bar: the faders want
               the width, and the screen has no height to give them -->
          <div v-if="stemsOpen" class="popover">
            <StemMixer
              :names="stemNames"
              :volume="stemVolume"
              @setVolume="(n, v) => emit('setStemVolume', n, v)"
              @mute="(n) => emit('muteStem', n)"
            />
          </div>
        </div>
      </div>

      <div class="group group--centre">
        <button class="btn" aria-label="Back to start" @click="emit('toStart')"><Icon name="start" /></button>
        <button class="btn" aria-label="Back 10 seconds" @click="emit('skip', -SKIP)"><Icon name="back" /></button>
        <button class="btn btn--play" :aria-label="playing ? 'Pause' : 'Play'" @click="emit('toggle')">
          <Icon :name="playing ? 'pause' : 'play'" />
        </button>
        <button class="btn" aria-label="Forward 10 seconds" @click="emit('skip', SKIP)"><Icon name="forward" /></button>
      </div>

      <div class="group group--side segmented">
        <button class="btn" :class="{ 'btn--on': view === 'video' }" aria-label="Video" title="Video" @click="view = 'video'">
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
</template>

<style scoped>
/* The bar is a stack of identical rows, as in asla: each one a flex line of `group`
   clusters that wraps as a whole rather than squashing what is inside it.
   Not `.bar` — a child component's root element also carries its parent's scope id, and
   App.vue's header is a `.bar`, which would then lay this out as a row. */
.controls {
  position: relative; /* the stems popover is placed against the whole bar */
  background: #050505;
  padding-bottom: env(safe-area-inset-bottom);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  background: #101010;
  flex-wrap: wrap;
}

.group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
/* Equal weight either side keeps the middle group centred. No min-width override, so the
   groups refuse to shrink under their contents and the row wraps instead of squashing
   the transport. */
.group--side { flex: 1 1 0; }
.group--side:last-child { justify-content: flex-end; }
.group--centre { flex: 0 0 auto; }
.group--off { opacity: 0.4; }

/* elapsed hard left, remaining hard right */
.stamp {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: #cfcfcf;
  flex: 0 0 auto;
  min-width: 8ch;
}
.stamp--right { text-align: right; }

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  height: 34px;
  padding-inline: 10px;
  border: 1px solid #333;
  border-radius: 6px;
  background: #1d1d1d;
  color: #e8e8e8;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap; /* or a squeezed row breaks "A-B" across two lines */
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.btn:hover:not(:disabled) { background: #2a2a2a; }
.btn:disabled { opacity: 0.35; cursor: default; }
.btn--on { background: #f59e0b; border-color: #f59e0b; color: #111; }
.btn--glyph { font-size: 20px; line-height: 1; }
.btn--play {
  min-width: 62px;
  height: 42px;
  margin-inline: 4px;
  background: #f59e0b;
  border-color: #f59e0b;
  color: #111;
  font-size: 17px;
}
.btn--play:hover:not(:disabled) { background: #ffad20; }

/* the mode switch reads as one control rather than two loose buttons */
.segmented { gap: 0; }
.segmented .btn {
  border-radius: 0;
  border-inline-width: 0 1px;
  min-width: 38px;
  padding-inline: 6px;
}
.segmented .btn:first-child {
  border-left-width: 1px;
  border-start-start-radius: 6px;
  border-end-start-radius: 6px;
}
.segmented .btn:last-child {
  border-start-end-radius: 6px;
  border-end-end-radius: 6px;
}

.row--loop {
  justify-content: center;
  gap: 24px;
  border-top: 1px solid #1e1e1e;
}

.overview { height: 60px; flex: none; }

/* the mix, small enough to sit on the bar: one glyph per stem, dimming with its fader */
.stems { display: flex; }
.btn--stems { gap: 6px; padding-inline: 9px; }
.btn--stems:disabled { opacity: 1; } /* it is a spinner, not a dead control */
/* open is marked with a ring rather than the usual amber fill, which would swallow the
   glyphs whole and take the mix off the bar exactly when it is being changed */
.btn--stems-open { border-color: #f59e0b; background: #241a06; }
.glyph { position: relative; display: block; color: #f59e0b; }
.glyph--off { color: #5a5a5a; }
/* struck through, so silence never reads as merely quiet */
.glyph--off::after {
  content: '';
  position: absolute;
  inset: 50% -2px auto -2px;
  height: 1.5px;
  border-radius: 2px;
  background: currentColor;
  transform: rotate(-20deg);
}

/* spans the bar, so it can never run off the side whichever way the rows have wrapped */
.popover {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  z-index: 5;
  padding: 11px 13px;
  border: 1px solid #2c2c2c;
  border-radius: 8px;
  background: #121212;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
}

.spin {
  width: 13px;
  height: 13px;
  border: 2px solid #3a3a3a;
  border-top-color: #f59e0b;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* the rows already wrap on their own; a phone only needs its readouts and its overview
   to take a little less room */
@media (max-width: 640px) {
  .row { gap: 8px; padding-inline: 8px; }
  .stamp { min-width: 6ch; }
  .overview { height: 46px; }
}

@media (max-width: 400px) {
  .btn { min-width: 34px; padding-inline: 7px; }
  .row :deep(.jog) { padding-inline: 6px; gap: 4px; }
  .overview { height: 42px; }
}
</style>
