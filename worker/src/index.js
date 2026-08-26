/**
 * LoopTube audio proxy.
 *
 * Why this exists: YouTube serves media over SABR now, so a browser cannot reach the
 * audio itself — the stream is only addressable by a client that speaks SABR and holds
 * a proof-of-origin token. A resolver service does that part and hands back a URL this
 * worker can relay with the CORS headers googlevideo itself refuses to send.
 *
 * Decoding stays in the browser: `decodeAudioData` already knows every container we get
 * back, so the worker never needs ffmpeg and stays a pure relay.
 *
 * Two traps this works around, both measured rather than guessed:
 *
 *  - googlevideo `n`-throttles a whole-file GET to ~11 KB/s, but serves byte ranges at
 *    several MB/s. So the file is pulled as a sequence of ranges and never as one GET.
 *  - googlevideo refuses some signed URLs when they are fetched from a datacenter ASN,
 *    deterministically per video. A URL that a browser on a home connection loads fine
 *    can 403 here. So a candidate is probed before it is committed to, and resolvers are
 *    tried in turn until one produces bytes.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Duration,X-Title,X-Format,X-Resolver',
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

const isVideoId = (v) => typeof v === 'string' && /^[\w-]{11}$/.test(v)
const watch = (id) => `https://www.youtube.com/watch?v=${id}`

/* ------------------------------------------------------------------ resolvers ----- */

/**
 * Each returns { title, duration, formats: [{ url, ext, bitrate }] }, cheapest first is
 * not assumed — the caller sorts. `direct` marks a resolver that serves the media from
 * its own infrastructure, which is immune to the datacenter block on googlevideo.
 */

async function clipto(id) {
  const r = await fetch('https://www.clipto.com/api/youtube', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ url: watch(id) }),
  })
  if (!r.ok) throw new Error(`http ${r.status}`)
  const j = await r.json()
  const formats = (j.medias ?? [])
    .filter((m) => m.type === 'audio' && m.url)
    .map((m) => ({ url: m.url, ext: m.ext, bitrate: m.bitrate | 0 }))
  if (!formats.length) throw new Error('no audio formats')
  return { title: j.title ?? '', duration: +j.duration || 0, formats }
}

// Tried in order until one yields bytes. Only clipto survives today: the transcoding
// services that host media themselves (loader.to and friends) answer "Access blocked"
// to datacenter requests, and cobalt requires a captcha-issued token.
const RESOLVERS = [{ name: 'clipto', fn: clipto, direct: false }]

/* --------------------------------------------------------------- byte plumbing ---- */

const CHUNK_MAX = 1 << 20 // 1 MiB, when the edge allows it
const CHUNK_MIN = 1 << 16 // 64 KiB, small enough that every edge seen will serve it
const TRIES = 12 // per chunk, across every size it steps down through

const PROBE = 65535 // ask for a real chunk, not one byte: they are not judged alike

/**
 * Size and type of a candidate, established by fetching the way we mean to continue.
 *
 * A one-byte range is a bad test — googlevideo will hand over `bytes=0-0` for a URL whose
 * first real chunk it then refuses, which used to leave the relay streaming a confident
 * zero bytes. Asking for a full chunk makes an unusable candidate fail here, where there
 * is still another resolver to try, instead of halfway through the response body.
 */
async function probe(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=0-${PROBE}` } })
  if (r.status !== 206 && r.status !== 200) throw new Error(`upstream ${r.status}`)
  const first = await r.arrayBuffer()
  if (first.byteLength < 1024) throw new Error('upstream returned an empty body')
  const total =
    Number((r.headers.get('Content-Range') ?? '').split('/')[1]) || Number(r.headers.get('Content-Length')) || 0
  if (!total) throw new Error('upstream gave no length')
  return { total, type: r.headers.get('Content-Type') ?? 'audio/mp4', ranged: r.status === 206 }
}

/**
 * Pull a byte range as a sequence of smaller ranged requests.
 *
 * Two limits shape this. A whole-file GET is `n`-throttled to ~11 KB/s, so the file is
 * never asked for in one piece. And some edges refuse a range over about 256 KiB from a
 * datacenter while happily serving a smaller one — the same URL, the same second. So the
 * chunk starts large and halves on refusal, which keeps the subrequest count low for the
 * edges that allow it without stranding the ones that do not.
 */
function rangedBody(url, from, to, ranged) {
  let pos = from
  let chunk = CHUNK_MAX
  let done = false
  return new ReadableStream({
    async pull(controller) {
      if (done || pos > to) return controller.close()

      // a source that ignored our probe range cannot be chunked; take it in one go
      if (!ranged) {
        const r = await fetch(url, { headers: { 'User-Agent': UA } })
        controller.enqueue(new Uint8Array(await r.arrayBuffer()))
        done = true
        return
      }

      // An edge under load answers with 206 and an *empty body* as readily as with 403,
      // and does it inconsistently for the same range seconds apart. Both mean "not now",
      // so both are retried, stepping the chunk down before giving up on the position.
      for (let attempt = 1; attempt <= TRIES; attempt++) {
        const end = Math.min(pos + chunk - 1, to)
        const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${pos}-${end}` } })
        const buf = r.status === 206 || r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null

        if (buf?.length) {
          controller.enqueue(buf)
          pos += buf.length
          return
        }
        // step the size down first, then simply wait: a refusal this consistent is the
        // edge pacing us, and it lets go after a moment
        if (chunk > CHUNK_MIN) chunk = Math.max(CHUNK_MIN, chunk >> 2)
        await new Promise((res) => setTimeout(res, Math.min(120 * attempt, 700)))
      }
      controller.error(new Error(`upstream refused bytes ${pos}- after ${TRIES} tries`))
    },
  })
}

/** `small` is the cheapest stream; `safe` is m4a, which every Safari can decode. */
function pick(formats, prefer) {
  const byBitrate = [...formats].sort((a, b) => a.bitrate - b.bitrate)
  if (prefer === 'safe') return byBitrate.find((f) => f.ext === 'm4a') ?? byBitrate[byBitrate.length - 1]
  return byBitrate[0]
}

/**
 * The first resolver whose URL actually yields bytes from here. Resolving is cheap;
 * being wrong about it is not, so nothing is returned until a range has come back.
 */
const ATTEMPTS = 2 // a resolver mints a fresh URL each call, and they are not equally lucky

async function candidate(id, prefer) {
  const tried = []
  let lastUrl = null
  for (const { name, fn } of RESOLVERS)
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
      const meta = await fn(id)
      const format = pick(meta.formats, prefer)
      if (!format?.url) throw new Error('no usable format')
      lastUrl = format.url
      const head = await probe(format.url)
      return { ...meta, format, head, resolver: name, tried }
    } catch (e) {
      // A signed URL for a geo-restricted video carries `gcr` and signs it, so it is only
      // honoured from that country by an address Google does not read as a datacenter.
      // No proxy can satisfy that, and saying which failure this is beats a bare 502.
      const geo = e.message.includes('403') && /[?&]gcr=/.test(lastUrl ?? '')
      tried.push(`${name}: ${geo ? 'geo-restricted (gcr) — not fetchable from a datacenter' : e.message}`)
      if (geo) throw Object.assign(new Error(tried.join(' | ')), { geo: true })
    }
  }
  throw new Error(tried.join(' | ') || 'no resolvers configured')
}

/** `bytes=start-end`, with either end optional. */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || !total) return null
  const start = m[1] ? Number(m[1]) : 0
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
  return start <= end ? { start, end } : null
}

/* -------------------------------------------------------------------- handler ----- */

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const url = new URL(request.url)
    const id = url.searchParams.get('v')

    if (url.pathname === '/' || url.pathname === '/health')
      return json({ ok: true, service: 'looptube-audio', endpoints: ['/meta?v=', '/audio?v=', '/diag?v='] })

    if (!isVideoId(id)) return json({ error: 'pass ?v=<11-character youtube id>' }, 400)

    try {
      // which resolvers work from this datacenter, and do their URLs actually serve bytes
      if (url.pathname === '/diag') {
        const report = []
        for (const { name, fn, direct } of RESOLVERS) {
          const started = Date.now()
          try {
            const meta = await fn(id)
            const format = pick(meta.formats, url.searchParams.get('fmt'))
            const entry = { resolver: name, direct, ms: Date.now() - started, resolved: true, host: new URL(format.url).hostname, ext: format.ext }
            try {
              const head = await probe(format.url)
              Object.assign(entry, { bytes: head.total, type: head.type, ranged: head.ranged, usable: true })
            } catch (e) {
              Object.assign(entry, { usable: false, probeError: e.message })
            }
            report.push(entry)
          } catch (e) {
            report.push({ resolver: name, direct, ms: Date.now() - started, resolved: false, error: e.message })
          }
        }
        return json({ id, report })
      }

      if (url.pathname === '/meta') {
        const { title, duration, formats, resolver } = await candidate(id, url.searchParams.get('fmt'))
        return json({ id, title, duration, resolver, formats: formats.map(({ ext, bitrate }) => ({ ext, bitrate })) })
      }

      if (url.pathname === '/audio') {
        const { title, duration, format, head, resolver } = await candidate(id, url.searchParams.get('fmt'))
        const { total, type, ranged } = head

        const wanted = parseRange(request.headers.get('Range'), total)
        const from = wanted?.start ?? 0
        const to = wanted?.end ?? (total ? total - 1 : Number.MAX_SAFE_INTEGER)

        const headers = new Headers(CORS)
        headers.set('Content-Type', type)
        headers.set('X-Duration', String(duration))
        headers.set('X-Format', format.ext ?? '')
        headers.set('X-Resolver', resolver)
        // header values must be latin-1, and titles are routinely not
        headers.set('X-Title', encodeURIComponent(title))
        headers.set('Cache-Control', 'public, max-age=86400')
        if (total) {
          headers.set('Accept-Ranges', 'bytes')
          headers.set('Content-Length', String(to - from + 1))
          if (wanted) headers.set('Content-Range', `bytes ${from}-${to}/${total}`)
        }

        return new Response(rangedBody(format.url, from, to, ranged), { status: wanted ? 206 : 200, headers })
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      return json({ error: String(e.message ?? e), geoRestricted: !!e.geo }, e.geo ? 451 : 502)
    }
  },
}
