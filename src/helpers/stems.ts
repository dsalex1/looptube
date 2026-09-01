import { serviceUrl } from '@/helpers/peaksSource'

/**
 * Stem separation, driven by the worker's /stems route (which runs it through Moises on a
 * Premium account). The worker resolves the source itself from the video id — the same way
 * /audio does — so all this needs is the id and which stems to pull.
 *
 * The four named stems come back plus a residual `other`; keeping `other` in the mix is
 * what lets "nothing muted" sound like the untouched track rather than a thin cut of it.
 */

/** What the UI shows while a split is in flight. */
export type StemPhase = 'separating' | 'downloading' | 'ready' | 'failed'

/** What the worker will isolate. `other` is the residual and is always added on top. */
export const SPLITTABLE = ['vocals', 'guitars', 'bass', 'drums', 'piano', 'keys', 'wind', 'strings'] as const
/** The click rendered from the beat grid; not a separation, so it is free of the cap. */
export const METRONOME = 'metronome'
export const MAX_STEMS = 5 // OPERATION_NOT_ALLOWED_MORE_THAN_5_STEMS
/** what is ticked the first time; whatever was picked last is remembered over it */
const DEFAULT_PICKS = ['vocals', 'guitars', 'bass', 'drums']
const PICKS_KEY = 'looptube:stemPicks'

export function rememberedPicks(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null')
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_PICKS
  } catch {
    return DEFAULT_PICKS
  }
}
export const rememberPicks = (picks: string[]) => {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks))
  } catch {
    /* storage blocked: the split still runs, it just will not be pre-ticked next time */
  }
}

// A stem's glyph and its readable name. Both the mixer and the button that opens it draw
// the same set, which is the whole point: the button is a small copy of what is inside.
const ICONS: Record<string, string> = {
  vocals: 'mic',
  guitars: 'guitar',
  bass: 'note',
  drums: 'drum',
  piano: 'note',
  keys: 'note',
  wind: 'note',
  strings: 'note',
  other: 'wave',
  metronome: 'drum',
}
const LABELS: Record<string, string> = {
  vocals: 'Vocals',
  guitars: 'Guitar',
  bass: 'Bass',
  drums: 'Drums',
  piano: 'Piano',
  keys: 'Keys',
  wind: 'Wind',
  strings: 'Strings',
  other: 'Other',
  metronome: 'Click',
}
export const stemIcon = (name: string) => ICONS[name] ?? 'wave'
export const stemLabel = (name: string) => LABELS[name] ?? name

const POLL_MS = 2500
const POLL_TIMEOUT_MS = 5 * 60_000

// The slow part is the separation, not the download, and Moises' stem URLs are immutable,
// so a finished split is remembered. Keyed by the video *and* what was asked for, since
// asking for a different set is a different separation. A stale URL (rare) just 404s on
// download, which drops the entry and re-splits — so the cache never wedges a video.
// bumped when the picks became the caller's, so entries from the fixed four do not match
const CACHE_KEY = 'looptube:stems3'
type StemUrls = Record<string, string>
type Cache = Record<string, { stems: StemUrls; at: number }>

const cacheKey = (id: string, requested: string[]) => `${id}|${[...requested].sort().join(',')}`

const readCache = (): Cache => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}')
  } catch {
    return {}
  }
}
const cachedStems = (key: string): StemUrls | null => readCache()[key]?.stems ?? null
function rememberStems(key: string, stems: StemUrls) {
  const cache = readCache()
  cache[key] = { stems, at: Date.now() }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* storage full or blocked: the split still works, it just will not be remembered */
  }
}
function forgetStems(key: string) {
  const cache = readCache()
  delete cache[key]
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('aborted', 'AbortError'))), { once: true })
  })

async function post(base: string, id: string, name: string, stems: string[], signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${base}/stems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: id, stems, name }),
    signal,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.taskId) throw new Error(j.error ?? `stems start failed (${r.status})`)
  return j.taskId
}

async function poll(base: string, taskId: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const until = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    if (Date.now() > until) throw new Error('separation timed out')
    const r = await fetch(`${base}/stems?taskId=${encodeURIComponent(taskId)}`, { signal })
    const j = await r.json().catch(() => ({}))
    if (j.status === 'COMPLETED') return j.stems as Record<string, string>
    if (j.status === 'FAILED' || j.status === 'ERROR' || !r.ok) throw new Error(j.error ?? `separation ${j.status ?? r.status}`)
    await sleep(POLL_MS, signal)
  }
}

/**
 * Split a video into stems and hand back the decoded-ready bytes per stem. `onPhase`
 * reports progress so the toggles can show "Separating…" then "Downloading…". Rejects on
 * abort, so a caller that has moved to another video can drop the result.
 */
async function download(stems: StemUrls, signal?: AbortSignal): Promise<Record<string, ArrayBuffer>> {
  const entries = await Promise.all(
    Object.entries(stems).map(async ([stem, url]) => {
      const r = await fetch(url, { signal })
      if (!r.ok) throw new Error(`stem ${stem} download ${r.status}`)
      return [stem, await r.arrayBuffer()] as const
    })
  )
  return Object.fromEntries(entries)
}

export async function separate(
  id: string,
  name: string,
  requested: string[],
  onPhase?: (phase: StemPhase) => void,
  signal?: AbortSignal
): Promise<Record<string, ArrayBuffer>> {
  const base = serviceUrl()
  const key = cacheKey(id, requested)
  const known = cachedStems(key)
  let stems = known
  if (!stems) {
    onPhase?.('separating')
    // the beat pass always runs, so a click comes back whether or not it was asked for
    const taskId = await post(base, id, name, requested.filter((s) => s !== METRONOME), signal)
    stems = await poll(base, taskId, signal)
    if (!requested.includes(METRONOME)) delete stems[METRONOME]
    rememberStems(key, stems)
  }

  onPhase?.('downloading')
  try {
    const bytes = await download(stems, signal)
    onPhase?.('ready')
    return bytes
  } catch (e) {
    if (signal?.aborted || !known) throw e
    forgetStems(key) // a remembered URL went stale; split again from scratch
    return separate(id, name, requested, onPhase, signal)
  }
}
