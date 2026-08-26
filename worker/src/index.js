/**
 * LoopTube audio proxy.
 *
 * Why this exists: YouTube serves media over SABR now, so a browser cannot reach the
 * audio itself — the stream is only addressable by a client that speaks SABR and holds
 * a proof-of-origin token. A resolver service does that part and hands back an ordinary
 * signed googlevideo URL. Those URLs are not IP-bound, so this worker can fetch one and
 * relay the bytes with the CORS headers googlevideo itself refuses to send.
 *
 * Decoding stays in the browser: `decodeAudioData` already knows every container we get
 * back, so the worker never needs ffmpeg and stays a pure relay.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Duration,X-Title,X-Format',
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })

const isVideoId = (v) => typeof v === 'string' && /^[\w-]{11}$/.test(v)

/**
 * Resolvers, tried in order. Each returns { title, duration, formats: [{url, ext, bitrate}] }
 * so one going dark only costs us a fallback rather than the feature.
 */
const RESOLVERS = [
  async function clipto(id) {
    const r = await fetch('https://www.clipto.com/api/youtube', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }),
    })
    if (!r.ok) throw new Error(`clipto http ${r.status}`)
    const j = await r.json()
    const formats = (j.medias ?? [])
      .filter((m) => m.type === 'audio' && m.url)
      .map((m) => ({ url: m.url, ext: m.ext, bitrate: m.bitrate | 0 }))
    if (!formats.length) throw new Error('clipto returned no audio formats')
    return { title: j.title ?? '', duration: +j.duration || 0, formats }
  },
]

async function resolve(id) {
  const failures = []
  for (const resolver of RESOLVERS) {
    try {
      return await resolver(id)
    } catch (e) {
      failures.push(`${resolver.name}: ${e.message}`)
    }
  }
  throw new Error(failures.join(' | ') || 'no resolvers configured')
}

/**
 * `small` is the cheapest opus stream and what the client asks for first; `safe` is m4a,
 * which every Safari can decode, and is the fallback when opus will not decode.
 */
function pick(formats, prefer) {
  const byBitrate = [...formats].sort((a, b) => a.bitrate - b.bitrate)
  if (prefer === 'safe') return byBitrate.find((f) => f.ext === 'm4a') ?? byBitrate[byBitrate.length - 1]
  return byBitrate[0]
}

const CHUNK = 1 << 20 // 1 MiB

/**
 * Pull a byte range as a sequence of smaller ranged requests.
 *
 * A whole-file GET to googlevideo gets `n`-parameter throttled to about 11 KB/s, which
 * is minutes per track. The same bytes asked for as ranges come back at several MB/s,
 * because the throttle is applied per request rather than per stream — so the relay
 * never issues the one request that would be slow.
 */
function rangedBody(url, from, to) {
  let pos = from
  return new ReadableStream({
    async pull(controller) {
      if (pos > to) return controller.close()
      const end = Math.min(pos + CHUNK - 1, to)
      const r = await fetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${pos}-${end}` } })
      if (r.status !== 206 && r.status !== 200) return controller.error(new Error(`upstream ${r.status}`))
      const buf = new Uint8Array(await r.arrayBuffer())
      if (!buf.length) return controller.close()
      controller.enqueue(buf)
      pos += buf.length
    },
  })
}

/** Total size and content type, from a one-byte range rather than a HEAD. */
async function probe(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' } })
  if (r.status !== 206 && r.status !== 200) throw new Error(`upstream ${r.status}`)
  await r.arrayBuffer()
  const total = Number((r.headers.get('Content-Range') ?? '').split('/')[1]) || Number(r.headers.get('Content-Length')) || 0
  return { total, type: r.headers.get('Content-Type') ?? 'audio/mp4' }
}

/** `bytes=start-end`, with either end optional. */
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || !total) return null
  const start = m[1] ? Number(m[1]) : 0
  const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1
  return start <= end ? { start, end } : null
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const url = new URL(request.url)
    const id = url.searchParams.get('v')

    if (url.pathname === '/' || url.pathname === '/health')
      return json({ ok: true, service: 'looptube-audio', endpoints: ['/meta?v=<id>', '/audio?v=<id>'] })

    if (!isVideoId(id)) return json({ error: 'pass ?v=<11-character youtube id>' }, 400)

    try {
      if (url.pathname === '/meta') {
        const { title, duration, formats } = await resolve(id)
        return json({ id, title, duration, formats: formats.map(({ ext, bitrate }) => ({ ext, bitrate })) })
      }

      if (url.pathname === '/audio') {
        const { title, duration, formats } = await resolve(id)
        const format = pick(formats, url.searchParams.get('fmt'))
        const { total, type } = await probe(format.url)

        const wanted = parseRange(request.headers.get('Range'), total)
        const from = wanted?.start ?? 0
        const to = wanted?.end ?? (total ? total - 1 : 0)

        const headers = new Headers(CORS)
        headers.set('Content-Type', type)
        headers.set('Accept-Ranges', 'bytes')
        headers.set('Content-Length', String(to - from + 1))
        if (wanted) headers.set('Content-Range', `bytes=${from}-${to}/${total}`.replace('bytes=', 'bytes '))
        headers.set('X-Duration', String(duration))
        headers.set('X-Format', format.ext ?? '')
        // header values must be latin-1, and titles are routinely not
        headers.set('X-Title', encodeURIComponent(title))
        headers.set('Cache-Control', 'public, max-age=86400')

        return new Response(rangedBody(format.url, from, to), { status: wanted ? 206 : 200, headers })
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      return json({ error: String(e.message ?? e) }, 502)
    }
  },
}
