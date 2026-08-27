/**
 * Keep decoded-once audio around, because fetching it again is the slow part.
 *
 * The relay at home takes seconds per track — it is a 2012 Raspberry Pi on the far side
 * of a tunnel — so re-opening a song you were working on a minute ago should not pay that
 * again. Cache Storage rather than IndexedDB: the payload is already a Response, and this
 * keeps the bytes out of the JS heap on the way in and out.
 */

const CACHE = 'looptube-audio-v1'
/** Enough to cover a practice session; the browser evicts the whole cache under pressure. */
const KEEP = 12

/** A stable key of our own, since the real URL is signed and expires within hours. */
const keyFor = (id: string) => `https://looptube.invalid/audio/${id}`

const store = () => (typeof caches === 'undefined' ? null : caches.open(CACHE))

export async function cached(id: string): Promise<Response | undefined> {
  try {
    return await (await store())?.match(keyFor(id))
  } catch {
    return undefined
  }
}

/**
 * Keep a copy, then trim to the most recent few. Cache Storage has no ordering of its
 * own, so insertion order is reconstructed from a stamp written alongside each entry.
 */
export async function keep(id: string, response: Response, meta: { title: string; duration: number; type: string }) {
  const cache = await store()
  if (!cache) return
  try {
    const headers = new Headers({
      'Content-Type': meta.type,
      'X-Duration': String(meta.duration),
      'X-Title': encodeURIComponent(meta.title),
      'X-Cached-At': String(Date.now()),
    })
    await cache.put(keyFor(id), new Response(response.body, { headers }))
    await trim(cache)
  } catch {
    /* quota, or a browser that will not store it: the app just refetches next time */
  }
}

async function trim(cache: Cache) {
  const entries = await cache.keys()
  if (entries.length <= KEEP) return
  const stamped = await Promise.all(
    entries.map(async (request) => ({
      request,
      at: Number((await cache.match(request))?.headers.get('X-Cached-At') ?? 0),
    }))
  )
  stamped.sort((a, b) => b.at - a.at)
  await Promise.all(stamped.slice(KEEP).map(({ request }) => cache.delete(request)))
}

export async function forgetAudio(id: string) {
  try {
    await (await store())?.delete(keyFor(id))
  } catch {
    /* nothing to do */
  }
}

export async function cachedIds(): Promise<Set<string>> {
  try {
    const entries = (await (await store())?.keys()) ?? []
    return new Set(entries.map((r) => r.url.split('/').pop()!).filter(Boolean))
  } catch {
    return new Set()
  }
}
