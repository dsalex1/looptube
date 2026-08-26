<script setup lang="ts">
import Controls from '@/components/Controls.vue'
import Icon from '@/components/Icon.vue'
import Settings from '@/components/Settings.vue'
import Stage from '@/components/Stage.vue'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useYouTubePlayer } from '@/composables/useYouTubePlayer'
import { fromFile, fromService, synthetic, type PeaksResult } from '@/helpers/peaksSource'
import { emptyState, fromHash, load as loadState, save as saveState, toHash } from '@/helpers/persist'
import { videoId } from '@/helpers/youtube'
import type { LoopState, PaneView, Transport } from '@/types'
import { useDebounceFn } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'

const SNAP = 1 // A/B snaps to a marker this close
const MARKER_HIT = 0.3 // pressing the marker button this close to one removes it instead
const DEFAULT_SPAN = 30 // seconds visible in the zoomed view
const NUDGE = 0.025 // seconds a single arrow press moves a loop point
const DRIFT = 0.35 // how far the muted video may wander from the audio before it is pulled back

const id = ref('')
const title = ref('')
const urlInput = ref('')
const view = ref<PaneView>('video')
const loopOpen = ref(false)
const markers = ref<number[]>([])
const peaks = ref<Uint8Array<ArrayBufferLike>>(new Uint8Array())
const isSynthetic = ref(true)
const status = ref('')
const settingsOpen = ref(false)
const span = ref(DEFAULT_SPAN)

const yt = useYouTubePlayer(() => document.getElementById('yt-host') ?? undefined)
const engine = useAudioEngine()

// The engine is vendored from asla, which had only ever one backend and so says nothing
// about what it can do. With the whole track decoded it can do everything.
const engineTransport = Object.assign(engine, {
  can: { pitch: true, boost: true, tempoSteps: null },
}) as unknown as Transport

/** Real audio beats the iframe: it is the only way to get pitch shifting and a boost. */
const useEngine = ref(false)
const active = computed<Transport>(() => (useEngine.value ? engineTransport : yt))

/** Bind a control to whichever transport is driving, so one set of controls serves both. */
function proxy<K extends 'tempo' | 'pitch' | 'gainDb'>(key: K) {
  return computed({
    get: () => active.value[key].value,
    set: (v: number) => (active.value[key].value = v),
  })
}
const tempo = proxy('tempo')
const pitch = proxy('pitch')
const gainDb = proxy('gainDb')

const currentTime = computed(() => active.value.currentTime.value)
// the engine only knows the duration once it has decoded, so the player's stands in
const duration = computed(() => active.value.duration.value || yt.duration.value)
const playing = computed(() => active.value.playing.value)
const loopA = computed(() => active.value.loopA.value)
const loopB = computed(() => active.value.loopB.value)
const hasLoop = computed(() => loopA.value != null && loopB.value != null)

const windowStart = computed(() => currentTime.value - span.value / 2)
const windowEnd = computed(() => currentTime.value + span.value / 2)
const markerAtPlayhead = computed(() => markers.value.some((m) => Math.abs(m - currentTime.value) <= MARKER_HIT))

// --- loading a video ---------------------------------------------------------------

function applyState(target: Transport, state: LoopState) {
  target.loopA.value = state.loopA
  target.loopB.value = state.loopB
  target.tempo.value = state.tempo
  target.pitch.value = state.pitch
  target.gainDb.value = state.gainDb
}

async function open(nextId: string, state = loadState(nextId)) {
  id.value = nextId
  title.value = state.title ?? ''
  markers.value = [...state.markers]
  useEngine.value = false
  isSynthetic.value = true
  peaks.value = new Uint8Array()
  span.value = DEFAULT_SPAN
  applyState(yt, state)

  await nextTick()
  await yt.mount(nextId)
  // the flat bed keeps the waveform usable while the real audio is still on its way
  adopt(synthetic(yt.duration.value || 300))
  void fetchAudio(nextId, state)
}

function adopt(result: PeaksResult) {
  peaks.value = result.peaks
  isSynthetic.value = !!result.synthetic
  if (result.title) title.value = result.title
}

let fetchToken = 0

async function fetchAudio(forId: string, state: LoopState) {
  const token = ++fetchToken
  status.value = 'Fetching audio…'
  try {
    const result = await fromService(forId)
    if (token !== fetchToken || id.value !== forId) return
    await activate(result, state)
    status.value = ''
  } catch (e) {
    if (token !== fetchToken) return
    console.warn('Audio service failed:', e)
    // not fatal: the video still plays and the loops still work, there is just no wave
    status.value = 'No audio samples — video looping still works'
    setTimeout(() => (status.value === 'No audio samples — video looping still works') && (status.value = ''), 6000)
  }
}

/** Hand playback to the Web Audio engine, carrying across whatever is set right now. */
async function activate(result: PeaksResult, state: LoopState) {
  if (!result.audioUrl) return adopt(result)
  const at = yt.currentTime.value
  const wasPlaying = yt.playing.value
  yt.pause()
  applyState(engineTransport, { ...state, tempo: yt.tempo.value, gainDb: yt.gainDb.value })
  await engine.load(result.audioUrl, result.duration)
  adopt(result)
  useEngine.value = true
  engine.seek(at)
  if (wasPlaying) engine.play()
}

function submit() {
  const next = videoId(urlInput.value)
  if (!next) {
    status.value = 'That does not look like a YouTube link'
    return
  }
  status.value = ''
  urlInput.value = ''
  void open(next)
}

// --- markers -----------------------------------------------------------------------

const nearestMarker = (seconds: number) =>
  markers.value.reduce<number | null>((best, m) => (best == null || Math.abs(m - seconds) < Math.abs(best - seconds) ? m : best), null)

function snap(seconds: number) {
  const nearest = nearestMarker(seconds)
  return nearest != null && Math.abs(nearest - seconds) <= SNAP ? nearest : seconds
}

function toggleMarker() {
  const at = currentTime.value
  if (!Number.isFinite(at)) return
  const existing = markers.value.findIndex((m) => Math.abs(m - at) <= MARKER_HIT)
  markers.value = existing >= 0 ? markers.value.filter((_, i) => i !== existing) : [...markers.value, at].sort((a, b) => a - b)
}

function moveMarker(index: number, seconds: number) {
  if (!Number.isFinite(seconds)) return
  markers.value = markers.value.map((m, i) => (i === index ? seconds : m)).sort((a, b) => a - b)
}

function jumpMarker(direction: -1 | 1) {
  const candidates = markers.value.filter((m) => (direction < 0 ? m < currentTime.value - 0.3 : m > currentTime.value))
  const target = direction < 0 ? candidates[candidates.length - 1] : candidates[0]
  active.value.seek(target ?? (direction < 0 ? 0 : duration.value))
}

// --- A-B repeat --------------------------------------------------------------------

function setLoop(which: 'a' | 'b', seconds = currentTime.value) {
  if (!Number.isFinite(seconds)) return
  const at = snap(seconds)
  const t = active.value
  if (which === 'a') {
    t.loopA.value = at
    if (t.loopB.value != null && t.loopB.value <= at) t.loopB.value = null
  } else {
    t.loopB.value = at
    if (t.loopA.value != null && t.loopA.value >= at) t.loopA.value = null
  }
}

function keepLoopOrdered() {
  const t = active.value
  if (t.loopA.value != null && t.loopB.value != null && t.loopB.value <= t.loopA.value)
    t.loopA.value = Math.max(0, t.loopB.value - NUDGE)
}

function nudgeLoop(direction: -1 | 1) {
  const t = active.value
  const delta = direction * NUDGE
  if (t.loopA.value != null) t.loopA.value = Math.max(0, t.loopA.value + delta)
  if (t.loopB.value != null) t.loopB.value = Math.min(duration.value, t.loopB.value + delta)
  keepLoopOrdered()
}

/** halve or double the selection, keeping A where it is */
function scaleLoop(factor: number) {
  const t = active.value
  if (t.loopA.value == null || t.loopB.value == null) return
  t.loopB.value = Math.min(duration.value, t.loopA.value + (t.loopB.value - t.loopA.value) * factor)
  keepLoopOrdered()
}

function clearLoop() {
  active.value.loopA.value = null
  active.value.loopB.value = null
}

// hiding the loop bar also stops the loop: the region stays, greyed out, but the track
// plays straight through it
watch(loopOpen, (open) => {
  yt.loopEnabled.value = open
  engine.loopEnabled.value = open
}, { immediate: true })

// --- keeping the muted video with the audio ----------------------------------------

watch(useEngine, (on) => {
  if (!on) return
  yt.gainDb.value = -60 // the engine is the one making sound now
})

watch(playing, (on) => {
  if (!useEngine.value) return
  if (on) yt.play()
  else yt.pause()
})

watch(currentTime, (at) => {
  if (!useEngine.value || !yt.playing.value) return
  if (Math.abs(yt.currentTime.value - at) > DRIFT) yt.seek(at)
})

watch(tempo, (v) => useEngine.value && (yt.tempo.value = v))

// --- persistence -------------------------------------------------------------------

const currentState = (): LoopState => ({
  markers: markers.value,
  loopA: loopA.value,
  loopB: loopB.value,
  tempo: tempo.value,
  pitch: pitch.value,
  gainDb: gainDb.value,
  title: title.value || undefined,
})

const persist = useDebounceFn(() => id.value && saveState(id.value, currentState()), 400)
watch([markers, loopA, loopB, tempo, pitch, gainDb, title], persist, { deep: true })

const copied = ref(false)
async function share() {
  const link = `${location.origin}${location.pathname}${toHash(id.value, currentState())}`
  try {
    await navigator.clipboard.writeText(link)
  } catch {
    location.hash = toHash(id.value, currentState()) // clipboard denied: at least put it in the bar
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}

async function pickFile(file: File) {
  status.value = 'Decoding file…'
  try {
    await activate(await fromFile(file), currentState())
    status.value = ''
  } catch {
    status.value = 'Could not decode that file'
  }
}

const zoom = (seconds: number) => (span.value = Math.max(2, Math.min(seconds, duration.value || span.value)))

function toStart() {
  active.value.seek(0)
}

// space plays, like every other transport
function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement
  if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA') return
  if (e.code === 'Space') {
    e.preventDefault()
    active.value.toggle()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  const shared = fromHash(location.hash)
  if (shared) void open(shared.id, { ...emptyState(), ...shared.state })
})

const error = computed(() => active.value.error.value || yt.error.value)
const shownStatus = computed(() => error.value || status.value)
</script>

<template>
  <div class="app">
    <header class="bar">
      <div class="brand"><Icon name="wave" stroke /><span>LoopTube</span></div>

      <form class="find" @submit.prevent="submit">
        <input
          v-model="urlInput"
          type="url"
          inputmode="url"
          placeholder="Paste a YouTube link…"
          spellcheck="false"
          autocomplete="off"
        />
        <button type="submit" class="go">Load</button>
      </form>

      <div class="title" :title="title">{{ title }}</div>

      <button v-if="id" class="icon" :class="{ 'icon--ok': copied }" title="Copy a link to this loop" @click="share">
        <Icon name="link" stroke />
      </button>
      <button class="icon" title="Settings" @click="settingsOpen = true"><Icon name="gear" stroke /></button>
    </header>

    <Stage
      v-if="id"
      :view="view"
      :peaks="peaks"
      :duration="duration"
      :start="windowStart"
      :end="windowEnd"
      :markers="markers"
      :loopA="loopA"
      :loopB="loopB"
      :loopActive="loopOpen"
      :position="currentTime"
      :synthetic="isSynthetic"
      :status="shownStatus"
      @seek="active.seek($event)"
      @moveMarker="moveMarker"
      @moveLoop="setLoop"
      @zoom="zoom"
    />

    <div v-else class="empty">
      <Icon name="wave" stroke />
      <h1>Loop any YouTube video</h1>
      <p>Paste a link above. You get A–B repeat, markers, tempo and a real waveform — the audio is decoded in your browser.</p>
    </div>

    <Controls
      v-if="id"
      v-model:tempo="tempo"
      v-model:pitch="pitch"
      v-model:gainDb="gainDb"
      v-model:view="view"
      v-model:loopOpen="loopOpen"
      :can="active.can"
      :playing="playing"
      :currentTime="currentTime"
      :duration="duration"
      :markerAtPlayhead="markerAtPlayhead"
      :hasLoop="hasLoop"
      @toggle="active.toggle()"
      @toStart="toStart"
      @skip="active.skip($event)"
      @marker="toggleMarker"
      @jumpMarker="jumpMarker"
      @setLoop="setLoop"
      @nudgeLoop="nudgeLoop"
      @scaleLoop="scaleLoop"
      @clearLoop="clearLoop"
    />

    <Settings v-if="settingsOpen" :hasRealAudio="!isSynthetic" @close="settingsOpen = false" @file="pickFile" />
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px calc(8px);
  padding-top: calc(8px + env(safe-area-inset-top));
  background: #0d0d0d;
  border-bottom: 1px solid #242424;
}
.brand { display: flex; align-items: center; gap: 7px; color: #e8bd6d; font-weight: 600; font-size: 14px; }
.find { display: flex; gap: 6px; flex: 1 1 260px; max-width: 460px; }
.find input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 11px;
  background: #151515;
  border: 1px solid #2e2e2e;
  border-radius: 7px;
  color: #ececec;
  font-size: 14px;
}
.find input:focus { outline: none; border-color: #e8bd6d; }
.go {
  height: 34px;
  padding: 0 13px;
  background: #e8bd6d;
  color: #101010;
  border: 0;
  border-radius: 7px;
  font-weight: 600;
  cursor: pointer;
}
.title {
  flex: 1 1 0;
  min-width: 0;
  color: #8f8f8f;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  background: #1a1a1a;
  border: 1px solid #2e2e2e;
  border-radius: 7px;
  color: #cfcfcf;
  cursor: pointer;
}
.icon--ok { color: #101010; background: #e8bd6d; border-color: #e8bd6d; }
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: #6f6f6f;
}
.empty svg { width: 44px; height: 44px; color: #e8bd6d; }
.empty h1 { margin: 0; font-size: 20px; color: #e6e6e6; font-weight: 600; }
.empty p { margin: 0; max-width: 46ch; line-height: 1.5; font-size: 14px; }
@media (max-width: 760px) {
  .title { display: none; }
  .brand span { display: none; }
}
</style>
