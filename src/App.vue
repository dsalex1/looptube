<script setup lang="ts">
import Controls from '@/components/Controls.vue'
import Icon from '@/components/Icon.vue'
import RecentGrid from '@/components/RecentGrid.vue'
import Settings from '@/components/Settings.vue'
import Stage from '@/components/Stage.vue'
import StartPage from '@/components/StartPage.vue'
import { installUpdate, updateReady } from '@/composables/useAppUpdate'
import { separate, type StemPhase } from '@/helpers/stems'
import { useAudioEngine } from '@/composables/useAudioEngine'
import { useYouTubePlayer } from '@/composables/useYouTubePlayer'
import { cachedIds } from '@/helpers/audioCache'
import { fromFile, fromService, synthetic, type PeaksResult } from '@/helpers/peaksSource'
import { forget, recents, remember, type Recent } from '@/helpers/recents'
import { followRate, JUMP, RATE_EPSILON, YT_RATE_MAX, YT_RATE_MIN } from '@/helpers/videoSync'
import { emptyState, fromHash, load as loadState, save as saveState, toHash } from '@/helpers/persist'
import { videoId } from '@/helpers/youtube'
import type { Capabilities, LoopState, PaneView, Transport } from '@/types'
import { useDebounceFn } from '@vueuse/core'
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue'

const SNAP = 1 // A/B snaps to a marker this close
const MARKER_HIT = 0.3 // pressing the marker button this close to one removes it instead
const DEFAULT_SPAN = 30 // seconds visible in the zoomed view

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
const recentsOpen = ref(false)
const span = ref(DEFAULT_SPAN)

// --- what has been opened before, and what is already on the device ------------------
const recentItems = ref<Recent[]>(recents())
const offlineIds = ref(new Set<string>())
const refreshOffline = async () => (offlineIds.value = await cachedIds())
const noteRecent = (entry: { id: string; title?: string; duration?: number }) => {
  remember(entry)
  recentItems.value = recents()
}
function dropRecent(dropped: string) {
  forget(dropped)
  recentItems.value = recents()
}

// --- how far the download has got, since the home relay is not instant ---------------
const loaded = ref(0)
const total = ref(0)
const busy = ref(false)
const progress = computed(() => (busy.value ? (total.value ? loaded.value / total.value : -1) : null))
// once the bytes are in, the wait that remains is the decode
const progressLabel = computed(() => (progress.value != null && progress.value >= 1 ? 'Decoding…' : 'Fetching audio…'))

const yt = useYouTubePlayer(() => document.getElementById('yt-host') ?? undefined)
const engine = useAudioEngine()

// The engine is vendored from asla, which had only ever one backend and so says nothing
// about what it can do. With the whole track decoded it can do everything.
const engineTransport = engine as unknown as Transport

/**
 * Which of the two is making sound.
 *
 * The video's own audio can never be out of step with the picture, so it is preferred and
 * the engine only takes over for the things it alone can do: shifting pitch, boosting past
 * unity, running outside the rates the player holds, playing a stem blend, or playing a
 * file that is not this video's audio at all. Whenever none of that is asked for, playback
 * goes back to the iframe and the question of keeping them together stops existing.
 */
const engineReady = ref(false) // the track is decoded and the engine could take over
const foreignAudio = ref(false) // what is loaded is not what the video would play

// the three the controls drive live here rather than on a transport, so they survive a
// handover and so setting one can be what triggers it
const tempo = ref(1)
const pitch = ref(0)
const gainDb = ref(0)

const stemsAdjusted = computed(() => engine.stemNames.value.some((n) => (engine.stemVolume.value[n] ?? 1) !== 1))

const needsEngine = computed(
  () =>
    foreignAudio.value ||
    pitch.value !== 0 ||
    gainDb.value > 0 ||
    tempo.value < YT_RATE_MIN ||
    tempo.value > YT_RATE_MAX ||
    stemsAdjusted.value
)
const useEngine = computed(() => engineReady.value && needsEngine.value)
const active = computed<Transport>(() => (useEngine.value ? engineTransport : yt))

// What the controls offer is what the track can be made to do, not what happens to be
// playing it: greying out pitch while the iframe drives would leave no way to ask for it.
const can = computed<Capabilities>(() =>
  engineReady.value ? { pitch: true, boost: true, tempoMin: 0.25, tempoMax: 4 } : yt.can
)

watch(tempo, (v) => ((yt.tempo.value = v), (engine.tempo.value = v)), { immediate: true })
watch(pitch, (v) => (engine.pitch.value = v), { immediate: true })
// the iframe can only attenuate, and is silenced outright while the engine has the floor
watch([gainDb, useEngine], ([v, on]) => {
  engine.gainDb.value = v
  yt.gainDb.value = on ? -60 : Math.min(v, 0)
}, { immediate: true })

// --- stems: asked for by hand from Settings, then offered as faders and mute toggles ----
// Not automatic: a split costs a separation for every video that is merely opened, so it
// waits to be asked for and the ask is kept off the transport bar.
const stemPhase = ref<StemPhase | ''>('')
const stemNames = computed(() => engine.stemNames.value)
const stemVolume = computed(() => engine.stemVolume.value)
let stemController: AbortController | null = null

function resetStems() {
  stemController?.abort()
  stemController = null
  stemPhase.value = ''
  engine.clearStems()
}

async function separateStems(requested: string[]) {
  const forId = id.value
  const name = title.value || forId
  settingsOpen.value = false
  resetStems()
  const controller = new AbortController()
  stemController = controller
  const mine = () => stemController === controller && id.value === forId
  try {
    const bytes = await separate(forId, name, requested, (p) => mine() && (stemPhase.value = p), controller.signal)
    if (!mine()) return
    await engine.setStems(bytes) // engine.stemPeaks now drives the waveform (watch below)
    stemPhase.value = ''
  } catch (e) {
    if (controller.signal.aborted) return
    console.warn('Stem separation failed:', e)
    stemPhase.value = 'failed'
    setTimeout(() => stemPhase.value === 'failed' && (stemPhase.value = ''), 5000)
  }
}

// the mix peaks follow every mute toggle, so the waveform is always the sum of what plays
watch(engine.stemPeaks, (p) => p.length && ((peaks.value = p), (isSynthetic.value = false)))

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

function applyState(state: LoopState) {
  tempo.value = state.tempo
  pitch.value = state.pitch
  gainDb.value = state.gainDb
  for (const t of [yt, engineTransport]) {
    t.loopA.value = state.loopA
    t.loopB.value = state.loopB
  }
}

async function open(nextId: string, state = loadState(nextId)) {
  recentsOpen.value = false
  resetStems()
  id.value = nextId
  noteRecent({ id: nextId, title: state.title })
  title.value = state.title ?? ''
  markers.value = [...state.markers]
  engineReady.value = false
  foreignAudio.value = false
  isSynthetic.value = true
  peaks.value = new Uint8Array()
  span.value = DEFAULT_SPAN
  applyState(state)

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
  status.value = ''
  loaded.value = 0
  total.value = 0
  busy.value = true
  try {
    const result = await fromService(forId, yt.duration.value, (got, size) => {
      if (token !== fetchToken) return
      loaded.value = got
      total.value = size
    })
    if (token !== fetchToken || id.value !== forId) return
    await activate(result, state)
    noteRecent({ id: forId, title: result.title, duration: result.duration })
    void refreshOffline()
    status.value = ''
  } catch (e) {
    if (token !== fetchToken) return
    console.warn('Audio service failed:', e)
    // not fatal: the video still plays and the loops still work, there is just no wave
    status.value = reasonFor(e)
    const shown = status.value
    setTimeout(() => status.value === shown && (status.value = ''), 7000)
  } finally {
    if (token === fetchToken) busy.value = false
  }
}

/**
 * Why the waveform is flat, in the user's terms. A geo-restricted video is the one case
 * no proxy can fix, so it is worth naming rather than blaming the network.
 */
function reasonFor(e: unknown) {
  const message = String((e as Error)?.message ?? e)
  if (message.includes('451') || /geo/i.test(message)) return 'This video is geo-restricted — load the audio from a file for the waveform'
  if (/incomplete/i.test(message)) return 'Only part of the audio came through — video looping still works'
  return 'No audio samples — video looping still works'
}

/**
 * Load the track into the engine and leave it idle. It does not start playing: the video's
 * own audio is already in sync with the picture, so the engine waits until something is
 * asked for that only it can do.
 */
async function activate(result: PeaksResult, state: LoopState) {
  adopt(result)
  if (!result.audioUrl) return
  await engine.load(result.audioUrl, result.duration)
  if (engine.error.value) return
  for (const t of [yt, engineTransport]) {
    t.loopA.value = state.loopA
    t.loopB.value = state.loopB
  }
  engineReady.value = true
}

const startError = ref('')
const filePicker = ref<HTMLInputElement>()

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void pickFile(file)
  input.value = '' // so the same file can be picked again after a change of mind
}

function submit(raw = urlInput.value) {
  const next = videoId(raw)
  if (!next) {
    const complaint = 'That does not look like a YouTube link'
    if (id.value) status.value = complaint
    else startError.value = complaint
    return
  }
  status.value = ''
  startError.value = ''
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

/** A and B are places you want to get back to as much as any marker, so they are targets too */
const jumpTargets = computed(() =>
  [...markers.value, loopA.value, loopB.value].filter((t): t is number => t != null).sort((a, b) => a - b)
)

function jumpMarker(direction: -1 | 1) {
  const candidates = jumpTargets.value.filter((m) => (direction < 0 ? m < currentTime.value - 0.3 : m > currentTime.value))
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

/** step the whole selection one selection-length forward or back, so you can walk the track */
function stepLoop(direction: -1 | 1) {
  const t = active.value
  if (t.loopA.value == null || t.loopB.value == null) return
  const length = t.loopB.value - t.loopA.value
  const start = Math.max(0, Math.min(t.loopA.value + direction * length, duration.value - length))
  t.loopA.value = start
  t.loopB.value = start + length
}

/** halve or double the selection, keeping A where it is */
function scaleLoop(factor: number) {
  const t = active.value
  if (t.loopA.value == null || t.loopB.value == null) return
  t.loopB.value = Math.min(duration.value, t.loopA.value + (t.loopB.value - t.loopA.value) * factor)
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

// --- handing over between the two, and keeping the muted video with the audio -------

let lastRate = 0

/** Move playback to whichever transport is now in charge, carrying the playhead with it. */
watch(useEngine, async (on, was) => {
  const from = was ? engineTransport : yt
  const to = on ? engineTransport : yt
  const at = from.currentTime.value
  const wasPlaying = from.playing.value
  from.pause()
  to.loopA.value = from.loopA.value
  to.loopB.value = from.loopB.value
  // the follower leaves the player running a shade off tempo; hand it back straight
  yt.setRate(tempo.value)
  lastRate = 0
  to.seek(at)
  if (wasPlaying) await to.play()
})

watch(playing, (on) => {
  if (!useEngine.value) return
  if (on) yt.play()
  else yt.pause()
})

/**
 * The picture chases the sound, by running a shade fast or slow rather than by being
 * seeked: every seek flickers the player's own controls, and a picture a tenth of a second
 * out is far easier to sit in front of than one that twitches. Only a real jump — a loop
 * wrapping, a scrub — is too wide to bend away, and only that is seeked.
 */
watch(currentTime, (at) => {
  if (!useEngine.value || !yt.playing.value) return
  const error = at - yt.currentTime.value
  if (Math.abs(error) > JUMP) return (lastRate = 0), yt.seek(at)
  const rate = followRate(tempo.value, error)
  if (Math.abs(rate - lastRate) < RATE_EPSILON) return
  lastRate = rate
  yt.setRate(rate)
})

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
  resetStems() // a picked file has no video id to split; drop any stems from before
  busy.value = true
  loaded.value = 0
  total.value = 0
  try {
    // a file with no video behind it still needs somewhere to play, so the pane keeps
    // whatever is loaded and simply swaps the audio underneath it
    foreignAudio.value = true
    await activate(await fromFile(file), currentState())
    status.value = ''
  } catch {
    status.value = 'Could not decode that file'
  } finally {
    busy.value = false
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
  void refreshOffline()
  const shared = fromHash(location.hash)
  if (shared) void open(shared.id, { ...emptyState(), ...shared.state })
})

const error = computed(() => active.value.error.value || yt.error.value)
const shownStatus = computed(() => error.value || status.value)

const build = __BUILD__
</script>

<template>
  <div class="app">
    <header class="bar">
      <div class="brand">
        <Icon name="wave" stroke />
        <div class="brand__name"><span>LoopTube</span><span class="version">{{ build }}</span></div>
      </div>

      <form v-if="id" class="find" @submit.prevent="submit()">
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

      <span v-if="!id" class="spacer" />

      <input ref="filePicker" type="file" accept="audio/*,video/*" hidden @change="onFileInput" />
      <button v-if="id" class="icon" title="Open an audio file" aria-label="Open an audio file" @click="filePicker?.click()">
        <Icon name="video" />
      </button>
      <!-- on the start page the recents are already on screen -->
      <button
        v-if="id && recentItems.length"
        class="icon"
        :class="{ 'icon--ok': recentsOpen }"
        title="Recent videos"
        aria-label="Recent videos"
        @click="recentsOpen = !recentsOpen"
      >
        <Icon name="clock" stroke />
      </button>
      <button v-if="id" class="icon" :class="{ 'icon--ok': copied }" title="Copy a link to this loop" @click="share">
        <Icon name="link" stroke />
      </button>
      <!-- only ever on screen when a new build is genuinely waiting -->
      <button v-if="updateReady" class="update" title="Reload onto the new version" @click="installUpdate()">
        <Icon name="download" stroke /><span>Update</span>
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
      :progress="progress"
      :progressLabel="progressLabel"
      @seek="active.seek($event)"
      @moveMarker="moveMarker"
      @moveLoop="setLoop"
      @zoom="zoom"
    />

    <StartPage
      v-if="!id"
      :items="recentItems"
      :offline="offlineIds"
      :error="startError"
      @submit="submit"
      @open="open($event)"
      @forget="dropRecent"
      @file="pickFile"
    />

    <Controls
      v-if="id"
      v-model:tempo="tempo"
      v-model:pitch="pitch"
      v-model:gainDb="gainDb"
      v-model:view="view"
      v-model:loopOpen="loopOpen"
      :can="can"
      :playing="playing"
      :currentTime="currentTime"
      :duration="duration"
      :markerAtPlayhead="markerAtPlayhead"
      :hasLoop="hasLoop"
      :peaks="peaks"
      :markers="markers"
      :loopA="loopA"
      :loopB="loopB"
      :stemNames="stemNames"
      :stemVolume="stemVolume"
      :stemPhase="stemPhase"
      @setStemVolume="engine.setStemVolume"
      @muteStem="engine.toggleStemMute"
      @toggle="active.toggle()"
      @seek="active.seek($event)"
      @toStart="toStart"
      @skip="active.skip($event)"
      @marker="toggleMarker"
      @jumpMarker="jumpMarker"
      @setLoop="setLoop"
      @stepLoop="stepLoop"
      @scaleLoop="scaleLoop"
      @clearLoop="clearLoop"
    />

    <!-- recents, reachable without giving up whatever is loaded -->
    <div v-if="recentsOpen" class="scrim" @click.self="recentsOpen = false">
      <div class="sheet">
        <header>
          <h2>Recent</h2>
          <button class="icon" aria-label="Close" @click="recentsOpen = false"><Icon name="close" stroke /></button>
        </header>
        <RecentGrid :items="recentItems" :offline="offlineIds" @open="open($event)" @forget="dropRecent" />
      </div>
    </div>

    <Settings
      v-if="settingsOpen"
      :hasRealAudio="!isSynthetic"
      :canSplit="!!id && !foreignAudio && !isSynthetic"
      :stemNames="stemNames"
      :stemPhase="stemPhase"
      @close="settingsOpen = false"
      @split="separateStems"
    />
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
.brand { display: flex; align-items: center; gap: 7px; color: #f59e0b; font-weight: 600; font-size: 14px; }
.brand__name { display: flex; flex-direction: column; line-height: 1.15; }
.update {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: #f59e0b;
  color: #1a1200;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.update svg { width: 14px; height: 14px; }
.brand .version { font-size: 10px; font-weight: 500; color: #6b6b6b; font-variant-numeric: tabular-nums; }
/* min-width:0 or the form refuses to shrink past its basis and shoves the last
   buttons off the side of a phone */
.find { display: flex; gap: 6px; flex: 1 1 260px; min-width: 0; max-width: 460px; }
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
.find input:focus { outline: none; border-color: #f59e0b; }
.go {
  height: 34px;
  padding: 0 13px;
  background: #f59e0b;
  color: #101010;
  border: 0;
  border-radius: 7px;
  font-weight: 600;
  cursor: pointer;
}
.spacer { flex: 1 1 auto; }
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
.icon--ok { color: #101010; background: #f59e0b; border-color: #f59e0b; }
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
  width: min(100%, 900px);
  max-height: 84vh;
  overflow: auto;
  background: #121212;
  border: 1px solid #2c2c2c;
  border-radius: 12px;
  padding: 16px 18px 20px;
}
.sheet header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.sheet h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b6b6b;
}
@media (max-width: 760px) {
  .title { display: none; }
  .brand__name span:first-child { display: none; }
}
</style>
