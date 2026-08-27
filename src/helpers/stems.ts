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

/** The stems offered as toggles, in display order. `other` rides along but is never listed. */
export const STEM_NAMES = ['vocals', 'guitars', 'bass', 'drums'] as const
export type StemName = (typeof STEM_NAMES)[number]

const POLL_MS = 2500
const POLL_TIMEOUT_MS = 5 * 60_000

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('aborted', 'AbortError'))), { once: true })
  })

async function post(base: string, id: string, name: string, signal?: AbortSignal): Promise<string> {
  const r = await fetch(`${base}/stems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: id, stems: STEM_NAMES, name }),
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
export async function separate(
  id: string,
  name: string,
  onPhase?: (phase: StemPhase) => void,
  signal?: AbortSignal
): Promise<Record<string, ArrayBuffer>> {
  const base = serviceUrl()
  onPhase?.('separating')
  const stems = await poll(base, await post(base, id, name, signal), signal)

  onPhase?.('downloading')
  const entries = await Promise.all(
    Object.entries(stems).map(async ([stem, url]) => {
      const r = await fetch(url, { signal })
      if (!r.ok) throw new Error(`stem ${stem} download ${r.status}`)
      return [stem, await r.arrayBuffer()] as const
    })
  )
  onPhase?.('ready')
  return Object.fromEntries(entries)
}
