import { computePeaks, decodeAudio } from '@/helpers/audioPeaks'

export interface PeaksResult {
  peaks: Uint8Array
  duration: number
  title?: string
  /** present only when real audio is in hand, which is what unlocks pitch shifting */
  audioUrl?: string
  /** true when the peaks are a flat bed rather than measured samples */
  synthetic?: boolean
}

export const SERVICE_KEY = 'looptube:service'

/** The deployed proxy, so a fresh browser gets real waveforms with nothing to configure. */
export const DEFAULT_SERVICE = 'https://looptube-audio.dsalex.workers.dev'

export const serviceUrl = () => (localStorage.getItem(SERVICE_KEY) ?? DEFAULT_SERVICE).replace(/\/$/, '')

export const setServiceUrl = (url: string) => localStorage.setItem(SERVICE_KEY, url.trim().replace(/\/$/, ''))

/** Anything shorter than this much of the real track is a cut-off download, not a track. */
const COMPLETE_ENOUGH = 0.95

async function attempt(
  base: string,
  id: string,
  fmt: string,
  expected: number,
  signal?: AbortSignal
): Promise<PeaksResult> {
  const response = await fetch(`${base}/audio?v=${encodeURIComponent(id)}&fmt=${fmt}`, { signal })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Audio service returned ${response.status}: ${detail.slice(0, 160)}`)
  }

  const bytes = await response.arrayBuffer()
  // decodeAudioData detaches what it is given, so the copy that becomes the playable
  // blob has to be taken before decoding rather than after
  const forPlayback = bytes.slice(0)
  const decoded = await decodeAudio(bytes)

  // Some googlevideo edges serve a datacenter only the first few hundred KB and then cut
  // us off. That still decodes — into a track that quietly ends early — so it is checked
  // against the length the player reports rather than trusted.
  if (expected && decoded.duration < expected * COMPLETE_ENOUGH)
    throw new Error(`incomplete audio: got ${decoded.duration.toFixed(0)}s of ${expected.toFixed(0)}s`)

  const type = response.headers.get('Content-Type') ?? 'audio/mp4'
  const title = decodeURIComponent(response.headers.get('X-Title') ?? '')
  return {
    peaks: computePeaks(decoded),
    duration: decoded.duration,
    title: title || undefined,
    audioUrl: URL.createObjectURL(new Blob([forPlayback], { type })),
  }
}

/**
 * Real peaks for a video id.
 *
 * YouTube serves media over SABR, so the browser cannot reach the stream itself; the
 * proxy resolves it and relays the bytes with CORS headers. Decoding stays here, where
 * the platform already has a decoder for every container the proxy can hand back.
 */
export async function fromService(id: string, expected = 0, signal?: AbortSignal): Promise<PeaksResult> {
  const base = serviceUrl()
  if (!base) throw new Error('No audio service configured')
  try {
    // opus is a third of the size, and every current browser decodes it
    return await attempt(base, id, 'small', expected, signal)
  } catch (e) {
    if (signal?.aborted) throw e
    // older Safari cannot decode opus in WebM, so fall back to the AAC stream
    return await attempt(base, id, 'safe', expected, signal)
  }
}

/** Peaks from a file the user picked, decoded entirely in the browser. */
export async function fromFile(file: File): Promise<PeaksResult> {
  const bytes = await file.arrayBuffer()
  const forPlayback = bytes.slice(0)
  const decoded = await decodeAudio(bytes)
  return {
    peaks: computePeaks(decoded),
    duration: decoded.duration,
    audioUrl: URL.createObjectURL(new Blob([forPlayback], { type: file.type || 'audio/mpeg' })),
  }
}

/**
 * The fallback that always works: no samples, so draw a flat bed. The waveform view still
 * earns its place — markers, the A-B region and the time ruler are all there; it just
 * cannot show where the transients are.
 */
export function synthetic(duration: number): PeaksResult {
  return { peaks: new Uint8Array(Math.max(1, Math.ceil(duration * 100))).fill(20), duration, synthetic: true }
}
