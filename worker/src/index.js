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

  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',

  'Access-Control-Allow-Headers': 'Range,Content-Type',

  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Duration,X-Title,X-Format,X-Resolver',

}



const json = (body, status = 200) =>

  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } })



const isVideoId = (v) => typeof v === 'string' && /^[\w-]{11}$/.test(v)



const UPSTREAM_KEY = 'pi'

/** A quick tunnel hands out a new name each start, so only the shape can be pinned. */

const TUNNEL_HOST = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/

/** Long enough to ride out a missed heartbeat, short enough that a dead Pi disappears. */

const UPSTREAM_TTL = 900



/** Constant-time-ish compare, so a wrong secret cannot be found one character at a time. */

function sameSecret(a, b) {

  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false

  let diff = 0

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)

  return diff === 0

}

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



/* ---------------------------------------------------------------------- stems ----- */

/**
 * Stem separation, driven through Moises' own studio API on the user's Premium plan. The
 * worker holds the credential and does the three privileged steps — sign in, upload, make
 * the task — then hands back the finished stem URLs. Those are public, CORS-*, range-
 * serving and immutable, so the browser fetches and caches them directly; no stem audio
 * passes through this worker.
 */

const FIREBASE_KEY = 'AIzaSyDWcFRZcUnN5EPNNA7jrcuS3HlIvMqtuCs' // public web key, referrer-locked
const MOISES_GQL = 'https://api.moises.ai/graphql'
const TOKEN_KEY = 'moises:token'
const TOKEN_TTL = 3000 // under Firebase's 3600 s, so a cached token is never spent near expiry

// Studio sends these on every call. The API 500s on a mutation missing the apollo client
// name, and wants the bare token with no "Bearer " prefix — both cost an hour to find.
const moisesHeaders = (token) => ({
  authorization: token,
  'x-client-name': 'ai.moises-studio-web',
  'x-client-version': '1.0.0',
  'apollographql-client-name': 'ai.moises-studio-web',
  'apollographql-client-version': '0.1.0',
  'apollographql-client-locale': 'en-US',
  accept: 'application/graphql-response+json, application/json',
  'content-type': 'application/json',
  'user-agent': UA,
  origin: 'https://studio.moises.ai',
  referer: 'https://studio.moises.ai/',
})

const VALID_STEMS = new Set(['vocals', 'guitars', 'bass', 'drums', 'piano', 'keys', 'wind', 'strings'])
const MAX_STEMS = 5 // OPERATION_NOT_ALLOWED_MORE_THAN_5_STEMS; the residual "other" is added on top

/** A cached Firebase ID token, or a fresh one signed in from email+password. */
async function moisesToken(env) {
  const cached = await env.UPSTREAM?.get(TOKEN_KEY)
  if (cached) return cached
  if (!env.MOISES_EMAIL || !env.MOISES_PASSWORD) throw new Error('moises credentials not configured')
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
    method: 'POST',
    // the key's referrer restriction is only a header check, so sending one is enough
    headers: { 'content-type': 'application/json', referer: 'https://studio.moises.ai/', 'user-agent': UA },
    body: JSON.stringify({ email: env.MOISES_EMAIL, password: env.MOISES_PASSWORD, returnSecureToken: true }),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.idToken) throw new Error(`moises sign-in failed: ${j.error?.message ?? r.status}`)
  await env.UPSTREAM?.put(TOKEN_KEY, j.idToken, { expirationTtl: TOKEN_TTL })
  return j.idToken
}

async function moisesGql(token, query, variables) {
  const r = await fetch(MOISES_GQL, {
    method: 'POST',
    headers: moisesHeaders(token),
    body: JSON.stringify({ query, variables: variables ?? {} }),
  })
  const j = await r.json().catch(() => null)
  if (!j) throw new Error(`moises ${r.status}`)
  if (j.errors) throw new Error(j.errors[0].message)
  return j.data
}

/**
 * Upload one file's bytes into Moises and start a separation. Moises hands back a GCS
 * signed PUT, so the bytes go straight to storage and only the two small mutations touch
 * this worker. Returns the task id to poll.
 */
async function startSeparation(token, audioBytes, name, stems) {
  const { uploadFile } = await moisesGql(
    token,
    'mutation($i:String!){uploadFile(input:$i,type:FILESYSTEM,resumable:false){signedUrl tempLocation}}',
    { i: `${name}.audio` },
  )
  const put = await fetch(uploadFile.signedUrl, { method: 'PUT', body: audioBytes })
  if (!put.ok) throw new Error(`upload PUT ${put.status}`)
  const { createTask } = await moisesGql(
    token,
    'mutation($f:FileInput!,$o:[OperationInput]){createTask(file:$f,operations:$o)}',
    {
      f: { provider: 'FILESYSTEM', tempLocation: uploadFile.tempLocation, name, input: `${name}.audio` },
      // the beat pass costs nothing extra here and renders a click on the beats it finds
      o: [
        { name: 'SEPARATE_CUSTOM', params: { stems } },
        { name: 'BEATSCHORDS_A', params: {} },
      ],
    },
  )
  return createTask
}

/** The task's separation status, and its stem URLs once COMPLETED. */
async function separationStatus(token, taskId) {
  const { track } = await moisesGql(token, 'query($id:String!){track(id:$id){operations{name status files}}}', {
    id: taskId,
  })
  const operations = track?.operations ?? []
  const op = operations.find((o) => o.name === 'SEPARATE_CUSTOM')
  if (!op) return { status: 'PENDING' } // the row exists a beat before its operation does
  if (op.status !== 'COMPLETED') return { status: op.status, files: op.files }
  // the click arrives with the beat pass, which can finish after the separation does
  const beats = operations.find((o) => o.name === 'BEATSCHORDS_A')
  if (beats && !['COMPLETED', 'FAILED', 'ERROR'].includes(beats.status)) return { status: 'RUNNING' }
  const metronome = beats?.files?.metronome
  return { status: op.status, files: metronome ? { ...op.files, metronome } : op.files }
}

/** Drain a ReadableStream into one Uint8Array. */
async function collect(stream) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * The source track's bytes, resolved the same way `/audio` plays them — reusing the same
 * resolver and ranged pull in-process, so nothing self-fetches. A geo-restricted URL only
 * serves to a home address, which is exactly what the Pi upstream is, so that is the fallback.
 */
async function sourceBytes(env, id) {
  try {
    const cand = await candidate(id, 'safe')
    return await collect(rangedBody(cand.format.url, 0, cand.head.total - 1, cand.head.ranged))
  } catch (e) {
    const pi = await env.UPSTREAM?.get(UPSTREAM_KEY, { type: 'json' })
    if (!pi?.url) throw e
    const r = await fetch(`${pi.url}/audio?v=${id}&fmt=safe`, { headers: { 'User-Agent': UA } })
    if (!r.ok) throw new Error(`pi source ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }
}

/* --------------------------------------------------------------------- search ----- */

/**
 * Finding a video by name, for callers that have a song title rather than a link. The
 * results page carries everything needed in its `ytInitialData`, so this reads that
 * instead of the Data API - no key, and no daily quota to run out of mid-rehearsal.
 */
function collectVideos(node, into) {
  if (!node || typeof node !== 'object') return into
  if (Array.isArray(node)) {
    for (const item of node) collectVideos(item, into)
    return into
  }
  const video = node.videoRenderer
  if (video?.videoId && video.title?.runs?.[0]?.text) {
    into.push({
      id: video.videoId,
      title: video.title.runs[0].text,
      channel: video.ownerText?.runs?.[0]?.text ?? video.longBylineText?.runs?.[0]?.text ?? '',
      duration: video.lengthText?.simpleText ?? '',
      thumbnail: video.thumbnail?.thumbnails?.[0]?.url ?? '',
    })
  }
  for (const value of Object.values(node)) collectVideos(value, into)
  return into
}

async function search(query) {
  const response = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&gl=US`, {
    // without a consent cookie some regions get an interstitial instead of results
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
  })
  const html = await response.text()
  const match = html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script>/s)
  if (!match) throw new Error('youtube returned no results block')
  const results = collectVideos(JSON.parse(match[1]), [])
  // the same video shows up in more than one shelf
  const seen = new Set()
  return results.filter((v) => !seen.has(v.id) && seen.add(v.id)).slice(0, 20)
}

/* -------------------------------------------------------------------- handler ----- */



export default {

  async fetch(request, env) {

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })



    const url = new URL(request.url)

    const id = url.searchParams.get('v')



    if (url.pathname === '/' || url.pathname === '/health')

      return json({
        ok: true,
        service: 'looptube-audio',
        endpoints: ['/meta?v=', '/audio?v=', '/diag?v=', '/search?q=', '/upstream', '/stems'],
      })

    if (url.pathname === '/search') {
      const query = url.searchParams.get('q')
      if (!query) return json({ error: 'q is required' }, 400)
      try {
        return json({ results: await search(query) })
      } catch (e) {
        return json({ error: String(e.message ?? e) }, 502)
      }
    }



    // Where the Pi currently is, if it is anywhere. The app prefers it because a home

    // connection is the only address googlevideo will serve geo-restricted audio to.

    if (url.pathname === '/upstream') {

      const stored = await env.UPSTREAM?.get(UPSTREAM_KEY, { type: 'json' })

      return json({ url: stored?.url ?? null, since: stored?.since ?? null })

    }



    // The Pi announces itself here on every start and then as a heartbeat. The secret

    // stops a stranger pointing the app at a server of their choosing, and the host

    // pattern limits the damage if the secret ever does leak.

    if (url.pathname === '/register') {

      if (request.method !== 'POST') return json({ error: 'POST only' }, 405)

      const body = await request.json().catch(() => null)

      // with no secret configured nothing may register, rather than everything
      const expected = env.REGISTER_SECRET
      if (!expected || !sameSecret(body?.secret ?? '', expected)) return json({ error: 'bad secret' }, 403)

      const target = String(body?.url ?? '').replace(/\/$/, '')

      if (!TUNNEL_HOST.test(target)) return json({ error: 'url must be a trycloudflare.com tunnel' }, 400)

      await env.UPSTREAM.put(UPSTREAM_KEY, JSON.stringify({ url: target, since: Date.now() }), {

        expirationTtl: UPSTREAM_TTL,

      })

      return json({ ok: true, url: target, ttl: UPSTREAM_TTL })

    }



    // Stem separation. POST ?v starts a job (resolves the source the same way /audio does,
    // Pi fallback and all), GET ?taskId polls it. The worker pulls the source once to hand
    // it to Moises; the finished stems are served from Moises' CDN straight to the browser.
    if (url.pathname === '/stems') {
      try {
        const token = await moisesToken(env)

        if (request.method === 'POST') {
          const body = await request.json().catch(() => null)
          const stems = Array.isArray(body?.stems) ? body.stems : []
          if (!stems.length || stems.length > MAX_STEMS || stems.some((s) => !VALID_STEMS.has(s)))
            return json({ error: `stems must be 1–${MAX_STEMS} of: ${[...VALID_STEMS].join(', ')}` }, 400)
          if (!isVideoId(body?.v)) return json({ error: 'v must be an 11-character youtube id' }, 400)
          const bytes = await sourceBytes(env, body.v)
          const name = String(body.name ?? body.v).replace(/[^\w-]/g, '').slice(0, 60) || 'track'
          return json({ taskId: await startSeparation(token, bytes, name, stems) })
        }

        if (request.method === 'GET') {
          const taskId = url.searchParams.get('taskId')
          if (!taskId) return json({ error: 'taskId required' }, 400)
          const { status, files } = await separationStatus(token, taskId)
          if (status === 'COMPLETED') return json({ status, stems: files })
          if (status === 'FAILED' || status === 'ERROR') return json({ status }, 502)
          return json({ status })
        }

        return json({ error: 'POST to start, GET ?taskId= to poll' }, 405)
      } catch (e) {
        return json({ error: String(e.message ?? e) }, 502)
      }
    }

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

