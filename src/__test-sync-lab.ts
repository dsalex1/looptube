/**
 * Sync lab: does the playhead the UI draws agree with the audio you actually hear?
 *
 * A generated test track carries one tone burst per whole second, each at its own pitch,
 * so a burst identifies the second it belongs to no matter how the time-stretcher has
 * mangled the spacing. `__test-sync-tap.js` reports, from the audio thread, the context
 * time at which each burst reached the graph; this side samples what the engine's
 * `currentTime` was at that same context time. The difference is the sync error, and a
 * positive one means the playhead - and so the waveform, and so the video that chases it
 * - is running ahead of the sound.
 *
 * Run it at /looptube/__test-sync-lab.html?auto=1, or headlessly through
 * scripts/__test-sync-collector.mjs.
 */
import { useAudioEngine } from '@/composables/useAudioEngine'
import { clampRate, DRIFT, videoDriftPerSecond } from '@/helpers/videoSync'

const SAMPLE_RATE = 48000
const TRACK_SECONDS = 45
const BURST_SECONDS = 0.08
const BASE_HZ = 400
const HZ_PER_SECOND = 40 // the burst at second k sounds at BASE_HZ + k * HZ_PER_SECOND
const AMPLITUDE = 0.5

const params = new URLSearchParams(location.search)
const tempos = (params.get('tempos') ?? '1,1.15,1.25,1.5,2,3').split(',').map(Number)
const dwell = Number(params.get('dwell') ?? 6) // seconds of wall clock measured per tempo

const out = document.getElementById('out')!

/** which second a burst belongs to, read back off its pitch */
const secondOf = (hz: number) => Math.round((hz - BASE_HZ) / HZ_PER_SECOND)

/** 16-bit mono WAV of the marker track, as something the engine can be handed to load */
function testTrackUrl() {
  const frames = TRACK_SECONDS * SAMPLE_RATE
  const bytes = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(bytes)
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + frames * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, frames * 2, true)

  for (let second = 0; second < TRACK_SECONDS; second++) {
    const hz = BASE_HZ + second * HZ_PER_SECOND
    const length = Math.round(BURST_SECONDS * SAMPLE_RATE)
    for (let i = 0; i < length; i++) {
      // hard attack, so the onset is where it says it is; a short fade out to stay clean
      const fade = Math.min(1, (length - i) / (0.005 * SAMPLE_RATE))
      const v = AMPLITUDE * fade * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
      view.setInt16(44 + (second * SAMPLE_RATE + i) * 2, v * 32767, true)
    }
  }
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
}

// The engine builds its own context and its own shifter and hands out neither, so both
// are caught on the way past: the tap has to sit on that same graph to measure it.
let context: AudioContext | null = null
let shifter: AudioWorkletNode | null = null
const NativeContext = window.AudioContext
const NativeWorkletNode = window.AudioWorkletNode
window.AudioContext = class extends NativeContext {
  constructor(options?: AudioContextOptions) {
    super(options)
    context = this
  }
}
window.AudioWorkletNode = class extends NativeWorkletNode {
  constructor(ctx: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
    super(ctx, name, options)
    if (name === 'soundtouch-processor') shifter = this
  }
}

const engine = useAudioEngine()

type Onset = { onset: number; hz: number }
let onsets: Onset[] = []
let tap: AudioWorkletNode | null = null

async function attachTap() {
  if (!context || !shifter) throw new Error('the engine never built its graph')
  if (!tap) {
    await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}__test-sync-tap.js`)
    tap = new NativeWorkletNode(context, 'sync-tap')
    tap.port.onmessage = ({ data }) => onsets.push(data)
    tap.connect(context.destination)
  }
  shifter.connect(tap) // pause() disconnects everything, so this is re-done every run
}

/** (context time, what the UI would have drawn) sampled per frame, for interpolation */
let clock: { at: number; position: number }[] = []
let sampling = false

function sample() {
  if (!sampling || !context) return
  clock.push({ at: context.currentTime, position: engine.currentTime.value })
  requestAnimationFrame(sample)
}

/** what the engine's playhead read at a given context time */
function positionAt(at: number) {
  const i = clock.findIndex((s) => s.at >= at)
  if (i <= 0) return null
  const [before, after] = [clock[i - 1], clock[i]]
  const span = after.at - before.at
  if (span <= 0 || span > 0.1) return null // across a stall an interpolation means nothing
  return before.position + ((at - before.at) / span) * (after.position - before.position)
}

/** every burst as it was heard and identified, so a bad run can be read rather than guessed at */
const diagnostics: { tempo: number; raw: unknown[] }[] = []

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function measure(tempo: number) {
  engine.tempo.value = tempo
  engine.seek(2) // clear of the burst at zero, so the first onset is unambiguous
  onsets = []
  clock = []
  await engine.play()
  await attachTap()
  sampling = true
  sample()
  await wait(dwell * 1000)
  sampling = false
  engine.pause()
  await wait(50)

  const errors: number[] = []
  const raw: { second: number; hz: number; drawn: number | null }[] = []
  for (const { onset, hz } of onsets) {
    const second = secondOf(hz)
    const drawn = positionAt(onset)
    raw.push({ second, hz: +hz.toFixed(1), drawn: drawn == null ? null : +drawn.toFixed(3) })
    if (second < 0 || second >= TRACK_SECONDS) continue // a burst too smeared to identify
    if (drawn != null) errors.push(drawn - second)
  }
  diagnostics.push({ tempo, raw })
  return { tempo, onsets: onsets.length, errors }
}

interface Report {
  sampleRate?: number
  outputLatencyMs: number
  audio: Record<string, number | string>[]
  video: Record<string, number>[]
}

async function run() {
  out.innerHTML = ''
  await engine.load(testTrackUrl())

  const latency = () => (context?.outputLatency ?? 0) + (context?.baseLatency ?? 0)
  const audio: Report['audio'] = []
  for (const tempo of tempos) {
    const { onsets: seen, errors } = await measure(tempo)
    if (!errors.length) {
      audio.push({ tempo, onsets: seen, used: 0, medianMs: 'n/a', spreadMs: 'n/a', atSpeakerMs: 'n/a' })
      continue
    }
    const mid = median(errors)
    audio.push({
      tempo,
      onsets: seen,
      used: errors.length,
      medianMs: +(mid * 1000).toFixed(1),
      spreadMs: +((Math.max(...errors) - Math.min(...errors)) * 1000).toFixed(1),
      // the graph clock leads the speaker by the output latency, and that lead is in
      // output seconds, so it counts for more track seconds the faster the track runs
      atSpeakerMs: +((mid + latency() * tempo) * 1000).toFixed(1),
    })
  }

  const video = tempos.map((tempo) => {
    const drift = videoDriftPerSecond(tempo)
    return {
      tempo,
      videoRate: clampRate(tempo),
      driftPerSecond: +drift.toFixed(3),
      resyncEverySeconds: drift ? +(DRIFT / drift).toFixed(2) : Infinity,
    }
  })

  const report: Report = {
    sampleRate: context?.sampleRate,
    outputLatencyMs: +(latency() * 1000).toFixed(1),
    audio,
    video,
  }
  render(report)
  const post = params.get('post')
  if (post) void fetch(post, { method: 'POST', body: JSON.stringify(report) })
  Object.assign(window, { __syncReport: report, __syncRaw: diagnostics })
}

function table(title: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return ''
  const keys = Object.keys(rows[0])
  const cell = (key: string, v: unknown) => {
    const loud = (key === 'medianMs' || key === 'atSpeakerMs' || key === 'driftPerSecond') && typeof v === 'number'
    return `<td class="${loud ? (Math.abs(v as number) > 0.04 ? 'bad' : 'ok') : ''}">${v}</td>`
  }
  return `<h2>${title}</h2><table><tr>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${keys.map((k) => cell(k, r[k])).join('')}</tr>`)
    .join('')}</table>`
}

function render(report: Report) {
  out.innerHTML =
    `<pre>sampleRate ${report.sampleRate} · output latency ${report.outputLatencyMs} ms</pre>` +
    table('playhead minus audio (ms; + means the playhead runs ahead of the sound)', report.audio) +
    table('muted video following the engine (drift in video-seconds per real second)', report.video)
}

document.getElementById('run')!.addEventListener('click', () => void run())
if (params.get('auto')) void run()
