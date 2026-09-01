import { computed, onUnmounted, ref, watch } from 'vue'
import { stretchFactory, type StretchNode } from '@/audio/signalsmith'
import { computePeaks } from '@/helpers/audioPeaks'

/** what a worklet is handed per call, and so how far its output trails the playhead */
const RENDER_QUANTUM = 128

/**
 * Streaming is not an option here: independent tempo and pitch need the whole
 * track decoded up front, so a track is fetched, decoded and kept in memory
 * while it is selected, and released as soon as another one is.
 *
 * The graph is
 *
 *   source per stem -> gain per stem -> mix -> [stretch] -> gain -> limiter -> speakers
 *
 * Tempo is `playbackRate` on the sources, which is native, sample-accurate and free —
 * but it transposes as it stretches, so Signalsmith Stretch is asked for whatever pitch
 * is left over (`shiftSemitones`) to put the key back. At 1x and 0 semitones there is
 * nothing left over and the mix goes straight to the output: a spectral engine always
 * processes, so routing through it at unity would be loss and nothing else.
 */
export function useAudioEngine() {
  const currentTime = ref(0)
  const duration = ref(0)
  const playing = ref(false)
  const loading = ref(false)
  const error = ref('')
  const tempo = ref(1)
  const pitch = ref(0)
  const loopA = ref<number | null>(null)
  const loopB = ref<number | null>(null)
  const gainDb = ref(0)
  /** A-B only repeats while the loop controls are on screen */
  const loopEnabled = ref(true)

  // --- stems --------------------------------------------------------------------------
  // When a track has been split, every stem gets its own source and its own GainNode and
  // the graph sums them, so a fader is a native gain ramp: nothing is re-mixed, nothing is
  // messaged, and the one stretcher downstream still works on the blend. The waveform is
  // that same blend, approximated from per-stem peaks so it tracks the faders.
  // display + channel order; anything the separator returns that is not here would be dropped
  const STEM_ORDER = ['vocals', 'guitars', 'bass', 'drums', 'piano', 'keys', 'wind', 'strings', 'other', 'metronome']
  /** the click is an addition to the recording rather than a part of it, so it starts off */
  const SILENT = new Set(['metronome'])
  const stemNames = ref<string[]>([]) // the stems present, in display order
  const stemVolume = ref<Record<string, number>>({}) // 0..1 per stem
  const stemPeaks = ref<Uint8Array>(new Uint8Array()) // peaks of the current blend, for the waveform
  const stemBuffers = new Map<string, AudioBuffer>() // kept: the sources read straight out of these
  const stemPeaksPer = new Map<string, Uint8Array>() // kept, so the waveform can be re-weighted
  const stemPrevVolume = new Map<string, number>() // what a stem returns to when un-muted
  const hasStems = () => stemNames.value.length > 0

  let context: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let mix: GainNode | null = null
  const stemGains = new Map<string, GainNode>()
  let sources: AudioBufferSourceNode[] = []
  let stretch: StretchNode | null = null
  let stretchPending: Promise<StretchNode | null> | null = null
  /** what the stretcher adds on the way through — measured, not assumed */
  let stretchLatency = 0
  let bypassed = true
  let gain: GainNode | null = null
  let limiter: DynamicsCompressorNode | null = null
  let preTap: AnalyserNode | null = null
  let postTap: AnalyserNode | null = null
  let loadToken = 0

  const audioContext = () => (context ??= new AudioContext())

  const amplitude = (db: number) => 10 ** (db / 20)

  // ~43 ms at 48 kHz: comfortably longer than a frame, so no peak falls between reads
  const TAP_WINDOW = 2048

  /**
   * Where the limiter holds the output, or null when it is out of the way. Only a boost
   * can clip, so cutting the trim passes straight through; the ceiling then eases in
   * over the first dB of boost rather than dropping to -1 dB the moment the gain moves.
   */
  const ceilingOf = (db: number) => (db > 0 ? -Math.min(db, 1) : null)
  const limiterCeilingDb = computed(() => ceilingOf(gainDb.value))

  function applyLimiter() {
    if (!limiter) return
    const ceiling = limiterCeilingDb.value
    limiter.threshold.value = ceiling ?? 0
    limiter.ratio.value = ceiling == null ? 1 : 20 // ratio 1 is a pass-through
  }

  /**
   * ... -> gain -> limiter -> speakers. The trim can boost by 20 dB, which would
   * clip on its own, so a brick-wall limiter sits after it: it is inaudible while the
   * signal stays under the threshold and only bites once the boost would have clipped.
   */
  function output() {
    if (!gain) {
      const ctx = audioContext()
      limiter = ctx.createDynamicsCompressor()
      limiter.knee.value = 0
      applyLimiter()
      limiter.attack.value = 0.003
      limiter.release.value = 0.1
      limiter.connect(ctx.destination)
      gain = ctx.createGain()
      gain.gain.value = amplitude(gainDb.value)
      gain.connect(limiter)
      // side branches, so monitoring cannot colour what you hear
      preTap = ctx.createAnalyser()
      postTap = ctx.createAnalyser()
      preTap.fftSize = postTap.fftSize = TAP_WINDOW
      gain.connect(preTap)
      limiter.connect(postTap)
    }
    return gain
  }

  function stopSources() {
    for (const s of sources) (s.stop(), s.disconnect())
    sources = []
  }

  function teardownGraph() {
    stopSources()
    mix?.disconnect()
    mix = null
    stemGains.clear()
    pause()
  }

  /** knownDuration lets the waveform be scrubbed while the file is still decoding */
  async function load(url: string, knownDuration = 0) {
    const token = ++loadToken
    teardownGraph()
    clearStems() // a new track starts without stems until it is split again
    buffer = null
    duration.value = knownDuration
    currentTime.value = 0
    loading.value = true
    error.value = ''
    try {
      const bytes = await (await fetch(url)).arrayBuffer()
      const decoded = await audioContext().decodeAudioData(bytes)
      if (token !== loadToken) return // a newer load won
      buffer = decoded
      duration.value = decoded.duration
    } catch (e) {
      if (token !== loadToken) return
      console.error('Failed to load audio track:', e)
      error.value = 'Could not load this audio track'
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  function clearStems() {
    stemBuffers.clear()
    stemPeaksPer.clear()
    stemPrevVolume.clear()
    stemNames.value = []
    stemVolume.value = {}
    stemPeaks.value = new Uint8Array()
  }

  /**
   * The waveform for the current fader positions: the per-stem peaks at their gains.
   *
   * Power, not amplitude: four stems do not hit their peaks in the same instant, so
   * adding their bytes overstates the mix by several decibels and pins it at the top of
   * the scale — which is what made the waveform jump and flatten the moment stems landed.
   * Adding their squares is the usual estimate for parts that are not in lockstep.
   */
  function recomputeStemPeaks() {
    const names = stemNames.value
    if (!names.length) return (stemPeaks.value = new Uint8Array())
    const len = names.reduce((m, n) => Math.max(m, stemPeaksPer.get(n)?.length ?? 0), 0)
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      let power = 0
      for (const n of names) {
        const level = (stemVolume.value[n] ?? 1) * (stemPeaksPer.get(n)?.[i] ?? 0)
        power += level * level
      }
      out[i] = Math.min(255, Math.round(Math.sqrt(power)))
    }
    stemPeaks.value = out
  }

  /** Adopt a freshly separated set of stems (raw bytes per stem) and start playing the blend. */
  async function setStems(bytesByStem: Record<string, ArrayBuffer>) {
    const ctx = audioContext()
    const decoded = await Promise.all(
      Object.entries(bytesByStem).map(async ([name, bytes]) => [name, await ctx.decodeAudioData(bytes)] as const)
    )
    clearStems()
    for (const [name, buf] of decoded) {
      stemBuffers.set(name, buf)
      stemPeaksPer.set(name, computePeaks(buf))
    }
    stemNames.value = STEM_ORDER.filter((n) => stemBuffers.has(n))
    stemVolume.value = Object.fromEntries(stemNames.value.map((n) => [n, SILENT.has(n) ? 0 : 1]))
    for (const name of SILENT) stemPrevVolume.set(name, 1) // so un-muting it lands at full
    recomputeStemPeaks()

    // switch playback from the whole-track buffer to the stem blend, holding the playhead
    const at = currentTime.value
    const wasPlaying = playing.value
    teardownGraph()
    buffer = null // the blend comes from the stems now, not the single buffer
    duration.value = decoded[0][1].duration
    currentTime.value = Math.min(at, duration.value)
    if (wasPlaying) await play()
  }

  /** Set one stem's level, 0..1. Live: a short ramp on its gain, and the waveform re-weights. */
  function setStemVolume(name: string, value: number) {
    if (!stemPeaksPer.has(name)) return
    const level = Math.max(0, Math.min(1, value))
    stemVolume.value = { ...stemVolume.value, [name]: level }
    if (context) stemGains.get(name)?.gain.setTargetAtTime(level, context.currentTime, 0.01)
    recomputeStemPeaks()
  }

  /** Icon click: drop a stem to silence, or bring it back to where its fader was. */
  function toggleStemMute(name: string) {
    const current = stemVolume.value[name] ?? 1
    if (current > 0) {
      stemPrevVolume.set(name, current)
      setStemVolume(name, 0)
    } else {
      setStemVolume(name, stemPrevVolume.get(name) ?? 1)
    }
  }

  // --- the stretcher ------------------------------------------------------------------

  /**
   * What to ask the stretcher for. `playbackRate` has already transposed the track by the
   * tempo, so the shift undoes that before it applies the capo the user asked for.
   */
  const shiftSemitones = () => pitch.value - 12 * Math.log2(tempo.value)

  /** at unity there is nothing for a spectral engine to do to the signal but degrade it */
  const isUnity = () => tempo.value === 1 && pitch.value === 0

  /** built on first use, so a track played straight through never pays for the WASM */
  function ensureStretch() {
    return (stretchPending ??= stretchFactory()
      .then((create) => create(audioContext()))
      .then(async (node) => {
        node.connect(output())
        node.start()
        stretchLatency = await node.latency()
        return (stretch = node)
      })
      .catch((e) => {
        // it runs in a worklet, which needs a secure origin: plain http on a LAN will not do
        console.error('Failed to start the pitch shifter:', e)
        error.value = 'Could not start audio - needs https and a 2021 or newer browser'
        stretchPending = null
        return null
      }))
  }

  /** Point the mix at the stretcher, or past it when there is nothing to shift. */
  async function route() {
    const node = isUnity() ? null : await ensureStretch()
    bypassed = !node
    node?.schedule({ semitones: shiftSemitones() })
    if (!mix) return
    mix.disconnect()
    mix.connect(node ?? output())
  }

  // --- playback -----------------------------------------------------------------------

  /** every stem, or the plain track as the one-stem case */
  const tracks = (): (readonly [string, AudioBuffer])[] =>
    stemBuffers.size
      ? stemNames.value.map((n) => [n, stemBuffers.get(n)!] as const)
      : buffer
        ? [['', buffer] as const]
        : []

  function buildGraph() {
    const ctx = audioContext()
    mix = ctx.createGain()
    for (const [name] of tracks()) {
      if (!name) continue
      const g = ctx.createGain()
      g.gain.value = stemVolume.value[name] ?? 1
      g.connect(mix)
      stemGains.set(name, g)
    }
  }

  /**
   * Sources are one-shot, so starting, seeking and crossing the bypass each mean a fresh
   * set. They read the same AudioBuffers throughout — the samples are never copied.
   */
  function startSources(at: number) {
    stopSources()
    const ctx = audioContext()
    for (const [name, buf] of tracks()) {
      if (at >= buf.duration) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = tempo.value
      src.connect(stemGains.get(name) ?? mix!)
      src.start(0, at)
      sources.push(src)
    }
  }

  // The playhead is driven off the audio clock: the stretcher's own `inputTime` reports
  // how far it has read ahead, which leads what you hear by a block or two.
  let baseContextTime = 0
  let baseTrackTime = 0
  let frame: number | null = null

  function rebase() {
    baseContextTime = audioContext().currentTime
    baseTrackTime = currentTime.value
  }

  /** how long the sound takes to get from the end of the graph out of the speakers */
  const hardwareLag = () => (context ? context.baseLatency + (context.outputLatency || 0) : 0)

  /**
   * How long ago the sound you are hearing right now left the sources. On top of the
   * hardware buffer the stretcher holds ~120 ms of its own whenever the mix runs through
   * it; at unity it is out of the path and costs nothing.
   */
  const outputLag = () => hardwareLag() + (bypassed ? 0 : stretchLatency)

  /**
   * Where the sound currently leaving the speakers sits in the track — which is what the
   * waveform should draw and what the muted video should be held to, rather than where
   * the graph has got to. The lag is measured in output seconds, so it stands for that
   * much more of the track the faster the track is being played: at 2x a 50 ms buffer is
   * 100 ms of music, and a playhead that ignored it would sit that far ahead of the beat.
   *
   * For the first `outputLag` after starting or seeking, nothing from the new position
   * has reached the speakers yet, so the playhead waits there rather than running backwards.
   */
  const positionNow = () =>
    baseTrackTime + Math.max(0, audioContext().currentTime - baseContextTime - outputLag()) * tempo.value

  /**
   * How far ahead of the heard playhead an A-B wrap has to be scheduled, in track seconds:
   * one output buffer, capped at half the loop so a selection shorter than the buffer
   * cannot re-trigger on every frame.
   */
  const wrapLead = () => Math.min(outputLag() * tempo.value, (loopB.value! - loopA.value!) / 2)

  function tick() {
    if (!playing.value) return
    const at = positionNow()
    // A-B repeat. The playhead is where the *sound* is, an `outputLag` behind the sources,
    // and stopping a source cannot un-render what is already in that buffer — so waiting
    // for it to reach B leaves a whole buffer of past-B audio queued and the wrap lands
    // that much late. The restart is scheduled off where the sources are instead, so the
    // last thing queued is B. (asla's playhead *is* the source position, hence no lag there.)
    if (looping() && at + wrapLead() >= loopB.value!) seek(loopA.value!)
    else if (at >= duration.value) (currentTime.value = duration.value), pause()
    else currentTime.value = at
    frame = requestAnimationFrame(tick)
  }

  async function play() {
    if (!tracks().length) return
    await audioContext().resume()
    if (!mix) buildGraph()
    await route()
    if (looping() && (currentTime.value < loopA.value! || currentTime.value >= loopB.value!)) seek(loopA.value!)
    startSources(currentTime.value)
    rebase()
    playing.value = true
    tick()
  }

  function pause() {
    // frames stop while the page is hidden, so take the position from the clock rather
    // than trusting whatever the last frame wrote
    if (playing.value) currentTime.value = Math.max(0, Math.min(positionNow(), duration.value))
    stopSources()
    playing.value = false
    if (frame) cancelAnimationFrame(frame)
    frame = null
  }

  const toggle = () => (playing.value ? pause() : play())

  const looping = () => loopEnabled.value && loopA.value != null && loopB.value != null

  const preSamples = new Float32Array(TAP_WINDOW)
  const postSamples = new Float32Array(TAP_WINDOW)

  /**
   * The most recent window of audio from either side of the limiter, as samples rather
   * than one peak: a caller that knows where the playhead is can place every sample at
   * the moment it belongs to, instead of smearing the whole window over one instant.
   *
   * `latency` is where that window sits relative to the playhead. The taps sit after the
   * stretcher, so its delay is already baked into what they hold and cancels out; what is
   * left is a render quantum of lead against a whole hardware buffer of it, so on balance
   * the window holds audio that has not been heard yet and the offset is negative.
   */
  function levels() {
    preTap?.getFloatTimeDomainData(preSamples)
    postTap?.getFloatTimeDomainData(postSamples)
    return {
      pre: preSamples,
      post: postSamples,
      sampleRate: context?.sampleRate ?? 48000,
      latency: RENDER_QUANTUM / (context?.sampleRate ?? 48000) - hardwareLag(),
      reduction: limiter?.reduction ?? 0,
    }
  }

  function seek(seconds: number) {
    if (!Number.isFinite(seconds)) return // a seek from a not-yet-measured waveform must not poison the position
    currentTime.value = Math.max(0, Math.min(seconds, duration.value))
    if (playing.value) startSources(currentTime.value)
    rebase()
  }

  const skip = (seconds: number) => seek(currentTime.value + seconds)

  /**
   * Tempo goes on the sources and the leftover pitch on the stretcher, both live and both
   * without a break. Only crossing into or out of the bypass needs more than that: it
   * moves the output by the stretcher's 120 ms, so the sources restart to line back up.
   */
  async function retune() {
    for (const s of sources) s.playbackRate.value = tempo.value
    const was = bypassed
    await route()
    if (playing.value && bypassed !== was) startSources(currentTime.value)
    rebase() // the clock slope changes with tempo, so restart the measurement from here
  }

  watch([tempo, pitch], () => void retune())
  // ramped rather than set, so dragging the trim does not click
  watch(gainDb, (v) => {
    gain?.gain.setTargetAtTime(amplitude(v), audioContext().currentTime, 0.01)
    applyLimiter()
  })

  onUnmounted(() => {
    teardownGraph()
    clearStems()
    buffer = null
    stretch?.disconnect()
    stretch = null
    stretchPending = null
    gain = null
    limiter = null
    preTap = postTap = null
    context?.close()
    context = null
  })

  return {
    currentTime, duration, playing, loading, error, tempo, pitch, gainDb,
    loopA, loopB, loopEnabled, limiterCeilingDb, load, play, pause, toggle, seek, skip, levels,
    stemNames, stemVolume, stemPeaks, hasStems, setStems, setStemVolume, toggleStemMute, clearStems,
  }
}
