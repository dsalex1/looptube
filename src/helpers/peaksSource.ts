import { computePeaks, decodeAudio } from '@/helpers/audioPeaks'
import { cached, keep } from '@/helpers/audioCache'

export interface PeaksResult {
  peaks: Uint8Array
  duration: number
  title?: string
  /** present only when real audio is in hand, which is what unlocks pitch shifting */
  audioUrl?: string
  /** true when the peaks are a flat bed rather than measured samples */
  synthetic?: boolean
  /** where the bytes came from, so the UI can say why it was quick or slow */
  source?: 'cache' | 'home' | 'worker' | 'file'
}

export type Progress = (loaded: number, total: number) => void

export const SERVICE_KEY = 'looptube:service'

/** The deployed proxy, so a fresh browser gets real waveforms with nothing to configure. */
export const DEFAULT_SERVICE = 'https://looptube-audio.dsalex.workers.dev'

export const serviceUrl = () => (localStorage.getItem(SERVICE_KEY) ?? DEFAULT_SERVICE).replace(/\/$/, '')

export const setServiceUrl = (url: string) => localStorage.setItem(SERVICE_KEY, url.trim().replace(/\/$/, ''))

/** Anything shorter than this much of the real track is a cut-off download, not a track. */
const COMPLETE_ENOUGH = 0.95

/** A dead tunnel should cost a moment, not a minute, before we fall back. */
const HEALTH_TIMEOUT = 5000
const DISCOVER_TIMEOUT = 5000
/** Re-ask where the home relay is now and then; it moves whenever it restarts. */
const DISCOVER_CACHE = 60_000

let discovered: { at: number; url: string | null } | null = null

const withTimeout = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

/**
 * Where the home relay currently is, if it is up.
 *
 * It matters because googlevideo refuses a datacenter for anything geo-restricted, so a
 * residential address is the only way to get roughly half of all music videos. The
 * address changes every time it restarts, so it is asked for rather than configured.
 */
async function upstream(signal?: AbortSignal): Promise<string | null> {
  if (discovered && Date.now() - discovered.at < DISCOVER_CACHE) return discovered.url
  try {
    const r = await fetch(`${serviceUrl()}/upstream`, { signal: withTimeout(DISCOVER_TIMEOUT, signal) })
    const { url } = (await r.json()) as { url: string | null }
    discovered = { at: Date.now(), url: url?.replace(/\/$/, '') ?? null }
  } catch {
    discovered = { at: Date.now(), url: null }
  }
  return discovered.url
}

/** The registration outlives a crash by design, so being listed is not being reachable. */
async function alive(base: string, signal?: AbortSignal) {
  try {
    const r = await fetch(`${base}/health`, { signal: withTimeout(HEALTH_TIMEOUT, signal) })
    return r.ok
  } catch {
    return false
  }
}

/** Read the body as it arrives, so a slow relay can show how far along it is. */
async function drain(response: Response, onProgress?: Progress): Promise<ArrayBuffer> {
  if (!response.body || !onProgress) return await response.arrayBuffer()

  const total = Number(response.headers.get('Content-Length')) || 0
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.length
    onProgress(loaded, total)
  }

  const joined = new Uint8Array(loaded)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined.buffer
}

/**
 * Turn raw bytes into peaks plus something the engine can play.
 *
 * `decodeAudioData` detaches the buffer it is handed, so the untouched copy is taken
 * first and then handed back: anything that wants the bytes afterwards — the blob to
 * play, the copy to cache — has to work from that one, not from the original.
 */
async function build(bytes: ArrayBuffer, type: string, title: string, source: PeaksResult['source']) {
  const forPlayback = bytes.slice(0)
  const decoded = await decodeAudio(bytes)
  const result: PeaksResult = {
    peaks: computePeaks(decoded),
    duration: decoded.duration,
    title: title || undefined,
    audioUrl: URL.createObjectURL(new Blob([forPlayback], { type })),
    source,
  }
  return { decoded, result, bytes: forPlayback }
}

/**
 * How long to wait for the first byte before giving up on a source. The home relay can
 * pass its health check and still wedge on a particular video — a tunnel that answers but
 * never streams — which would otherwise hang the whole load, since the body has no
 * deadline of its own. The guard is cleared the moment headers arrive, so a slow but
 * working download is never cut off mid-stream.
 */
const FIRST_BYTE_TIMEOUT = 12_000

async function attempt(
  base: string,
  id: string,
  fmt: string,
  expected: number,
  source: 'home' | 'worker',
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<PeaksResult> {
  const ttfb = new AbortController()
  const timer = setTimeout(() => ttfb.abort(new DOMException('first-byte timeout', 'TimeoutError')), FIRST_BYTE_TIMEOUT)
  const guard = signal ? AbortSignal.any([signal, ttfb.signal]) : ttfb.signal
  let response: Response
  try {
    response = await fetch(`${base}/audio?v=${encodeURIComponent(id)}&fmt=${fmt}`, { signal: guard })
  } finally {
    clearTimeout(timer) // headers are in (or we failed); the body streams without the deadline
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Audio service returned ${response.status}: ${detail.slice(0, 160)}`)
  }

  const type = response.headers.get('Content-Type') ?? 'audio/mp4'
  const title = decodeURIComponent(response.headers.get('X-Title') ?? '')
  const { decoded, result, bytes } = await build(await drain(response, onProgress), type, title, source)

  // Some googlevideo edges serve a datacenter only the first few hundred KB and then cut
  // us off. That still decodes — into a track that quietly ends early — so it is checked
  // against the length the player reports rather than trusted.
  if (expected && decoded.duration < expected * COMPLETE_ENOUGH)
    throw new Error(`incomplete audio: got ${decoded.duration.toFixed(0)}s of ${expected.toFixed(0)}s`)

  void keep(id, new Response(bytes), { title, duration: decoded.duration, type })
  return result
}

/**
 * Real peaks for a video id: from the cache if we have them, then the home relay, then
 * the worker. Only the first is quick, which is the whole reason the cache exists.
 */
export async function fromService(
  id: string,
  expected = 0,
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<PeaksResult> {
  const hit = await cached(id)
  if (hit) {
    const type = hit.headers.get('Content-Type') ?? 'audio/mp4'
    const title = decodeURIComponent(hit.headers.get('X-Title') ?? '')
    const { result } = await build(await hit.arrayBuffer(), type, title, 'cache')
    return result
  }

  const worker = serviceUrl()
  if (!worker) throw new Error('No audio service configured')

  // The home relay first when it is actually answering, the worker always as the floor.
  // The worker is quicker; the relay is the only one that can fetch geo-restricted audio.
  const bases: { url: string; source: 'home' | 'worker' }[] = []
  const home = await upstream(signal)
  if (home && (await alive(home, signal))) bases.push({ url: home, source: 'home' })
  bases.push({ url: worker, source: 'worker' })

  let last: unknown
  for (const { url, source } of bases)
    // opus is a third of the size; older Safari cannot decode it, hence the AAC retry
    for (const fmt of ['small', 'safe']) {
      try {
        return await attempt(url, id, fmt, expected, source, onProgress, signal)
      } catch (e) {
        if (signal?.aborted) throw e
        last = e
      }
    }
  throw last ?? new Error('no audio source could serve this video')
}

/** Peaks from a file the user picked, decoded entirely in the browser. */
export async function fromFile(file: File): Promise<PeaksResult> {
  const bytes = await file.arrayBuffer()
  const { result } = await build(bytes, file.type || 'audio/mpeg', '', 'file')
  return result
}

/**
 * The fallback that always works: no samples, so draw a flat bed. The waveform view still
 * earns its place — markers, the A-B region and the time ruler are all there; it just
 * cannot show where the transients are.
 */
export function synthetic(duration: number): PeaksResult {
  return { peaks: new Uint8Array(Math.max(1, Math.ceil(duration * 100))).fill(20), duration, synthetic: true }
}
