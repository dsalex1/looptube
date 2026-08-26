import { PitchShifter } from 'soundtouchjs'
import { computed, onUnmounted, ref, watch } from 'vue'

const BUFFER_SIZE = 4096

/**
 * Streaming is not an option here: independent tempo and pitch need the whole
 * track decoded up front, so a track is fetched, decoded and kept in memory
 * while it is selected, and released as soon as another one is.
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

  let context: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let shifter: PitchShifter | null = null
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
   * shifter -> gain -> limiter -> speakers. The trim can boost by 20 dB, which would
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


  function teardownShifter() {
    shifter?.disconnect()
    shifter = null
    pause()
  }

  /** knownDuration lets the waveform be scrubbed while the file is still decoding */
  async function load(url: string, knownDuration = 0) {
    const token = ++loadToken
    teardownShifter()
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

  function ensureShifter() {
    if (shifter || !buffer) return shifter
    shifter = new PitchShifter(audioContext(), buffer, BUFFER_SIZE, () => pause())
    shifter.tempo = tempo.value
    shifter.pitchSemitones = pitch.value
    seekShifter(currentTime.value)
    return shifter
  }

  // SoundTouch reports how far it has read ahead, which leads what you hear by a few
  // hundred ms, so the playhead is driven off the audio clock instead.
  let baseContextTime = 0
  let baseTrackTime = 0
  let frame: number | null = null

  function rebase() {
    baseContextTime = audioContext().currentTime
    baseTrackTime = currentTime.value
  }

  const positionNow = () => baseTrackTime + (audioContext().currentTime - baseContextTime) * tempo.value

  function tick() {
    if (!playing.value) return
    const at = positionNow()
    // A-B repeat: jump back as soon as the playhead runs past B
    if (looping() && at >= loopB.value!) seek(loopA.value!)
    else if (at >= duration.value) (currentTime.value = duration.value), pause()
    else currentTime.value = at
    frame = requestAnimationFrame(tick)
  }

  async function play() {
    const s = ensureShifter()
    if (!s) return
    await audioContext().resume()
    if (looping() && (currentTime.value < loopA.value! || currentTime.value >= loopB.value!)) seek(loopA.value!)
    rebase()
    s.connect(output())
    playing.value = true
    tick()
  }

  function pause() {
    // frames stop while the page is hidden, so take the position from the clock rather
    // than trusting whatever the last frame wrote
    if (playing.value) currentTime.value = Math.max(0, Math.min(positionNow(), duration.value))
    shifter?.disconnect()
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
   * `latency` is how far behind the playhead that window sits. The pitch shifter is a
   * ScriptProcessor, so what it computed for a given position only reaches the graph a
   * whole buffer later, and that offset is what would otherwise drag the readings late.
   */
  function levels() {
    preTap?.getFloatTimeDomainData(preSamples)
    postTap?.getFloatTimeDomainData(postSamples)
    return {
      pre: preSamples,
      post: postSamples,
      sampleRate: context?.sampleRate ?? 48000,
      latency: BUFFER_SIZE / (context?.sampleRate ?? 48000),
      reduction: limiter?.reduction ?? 0,
    }
  }

  const seekShifter = (seconds: number) => {
    if (shifter && duration.value) shifter.percentagePlayed = seconds / duration.value
  }

  function seek(seconds: number) {
    if (!Number.isFinite(seconds)) return // a seek from a not-yet-measured waveform must not poison the position
    currentTime.value = Math.max(0, Math.min(seconds, duration.value))
    seekShifter(currentTime.value)
    rebase()
  }

  const skip = (seconds: number) => seek(currentTime.value + seconds)

  // the clock slope changes with tempo, so restart the measurement from here
  watch(tempo, (v) => {
    rebase()
    if (shifter) shifter.tempo = v
  })
  watch(pitch, (v) => shifter && (shifter.pitchSemitones = v))
  // ramped rather than set, so dragging the trim does not click
  watch(gainDb, (v) => {
    gain?.gain.setTargetAtTime(amplitude(v), audioContext().currentTime, 0.01)
    applyLimiter()
  })

  onUnmounted(() => {
    teardownShifter()
    buffer = null
    gain = null
    limiter = null
    preTap = postTap = null
    context?.close()
    context = null
  })

  return {
    currentTime, duration, playing, loading, error, tempo, pitch, gainDb,
    loopA, loopB, loopEnabled, limiterCeilingDb, load, play, pause, toggle, seek, skip, levels,
  }
}
