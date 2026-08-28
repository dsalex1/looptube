# LoopTube

Practise along to any YouTube video: A–B repeat, markers, tempo, pitch and a **real
waveform** — switch between the video and the waveform from the bottom right.

The audio pane is lifted from [alex-set-list-app](https://github.com/dsalex1/alex-set-list-app);
this is the same transport bolted onto YouTube instead of an uploaded track.

**Live:** https://dsalex1.github.io/looptube/

## What it does

- **A–B repeat** with nudge, halve/double, and snapping to markers
- **Markers** you can drop, drag, and jump between
- **Tempo** 0.25×–4× and **pitch** ±12 semitones, independently
- **Level trim** with a brick-wall limiter, so quiet backing tracks come up without clipping
- **Two views** — the video, or the waveform — swapped from the bottom-right corner
- **Overview strip** above the transport: the whole track at a glance, tap to seek
- **Recent videos** on the start page and behind the clock icon while one is open
- **Cached audio**, so re-opening a track costs ~0.7 s instead of another trip to the Pi
- **State per video** in `localStorage`, plus a shareable permalink
- **Installable** as a PWA, and laid out for a phone as well as a desktop

## Why there is a proxy

This is the whole design problem, so it is worth writing down.

A browser **cannot** read the audio out of a YouTube video:

- The iframe is cross-origin. `contentDocument` is null and `captureStream()` needs a
  same-origin media element. This is same-origin policy, not CORS — **no header fixes it**,
  and a CORS proxy does not help.
- YouTube has moved to **SABR**. The player response no longer carries per-format `url`
  or `signatureCipher` fields at all, only a `serverAbrStreamingUrl` that requires
  protobuf requests plus a proof-of-origin (PO) token minted by YouTube's BotGuard VM.

That is why the public YouTube frontends broke: across ~35 live Invidious and Piped
instances, metadata resolves everywhere and audio streams resolve nowhere. One Invidious
instance says so outright — *"Companion is starting. Please wait until a valid potoken is
found."*

So a resolver service does the hard part and returns an ordinary signed `googlevideo.com`
URL. Two things make that useful:

1. **The signature is not tied to the resolver's own address.** A URL minted on the
   resolver's server is served to other clients too, so nothing here has to speak SABR or
   hold a PO token. It is not a free pass — see the datacenter wall below — but the hard
   part is already done by the time the URL reaches us.
2. **The browser can still do the decoding.** `decodeAudioData` handles every container
   the resolver returns, so the worker needs no ffmpeg, no yt-dlp, no container — it is a
   ~150-line relay that adds the CORS headers `googlevideo` refuses to send.

### The throttling trap

A whole-file `GET` to `googlevideo` is `n`-parameter throttled to about **11 KB/s** —
minutes for one track. The identical bytes requested as `Range` chunks arrive at
**~4 MB/s**, because the throttle is applied per request. The worker therefore never
issues the one request that would be slow; it pulls 1 MiB ranges in sequence.

| Method | Throughput | 1.2 MB track |
| --- | --- | --- |
| Un-ranged `GET` | 11 KB/s | ~110 s |
| Sequential 1 MiB ranges | ~4 MB/s | 0.3 s |

### The datacenter wall

This is the real limit, and it is not fixable by choosing a better host.

Signed googlevideo URLs for **geo-restricted** videos carry a `gcr` parameter that is
covered by the signature (`sparams` is four characters longer). Those URLs are only
honoured from that country by an address Google does not read as a datacenter. The same
URL loads fine from a home connection and 403s from Cloudflare, deterministically, on
every edge in the URL's `mn` list — host rotation was tried and every edge refused alike.

A second, softer version of the same wall: some edges serve a datacenter the first
~448 KB and then cut it off, answering `206` with an **empty body** rather than an error.
Retrying, backing off and stepping the chunk size down does not move that ceiling. So the
client checks the decoded length against the length the player reports and rejects a
short track rather than drawing a waveform that quietly ends early.

**Choosing a different host does not help, and this was tested rather than assumed.** The
same probe was deployed to Cloud Functions in `europe-west3` (Frankfurt), on the theory
that a German Google IP is exactly what a `gcr=de` URL asks for:

| egress | geolocates as | unrestricted video | `gcr=de` videos |
| --- | --- | --- | --- |
| Cloudflare Workers (IPv6) | DE | works | 403 |
| GCP Frankfurt, IPv6 | DE | works | 403 |
| GCP Frankfurt, IPv4 `34.96.39.171` | DE | works | 403 |
| home connection (IPv4) | DE | works | **works** |

Google's own geolocation calls the Cloud Run address `DE` and still refuses it, and
pinning the address family changes nothing — so it is the datacenter, not the country and
not IPv6. Google blocks its own cloud harder than Cloudflare: on the same five videos GCP
served one and Cloudflare served four.

Measured over 12 videos on Cloudflare: **7 give a real waveform, 5 are geo-restricted.**
The geo-restricted ones skew towards major-label music, which is unfortunate for a
practice tool — for those, load the audio from a file and everything works.

### The home relay

The one address that clears all of this is a **residential** one, so `pi/` is the same
relay written to run at home. With it up, all twelve test videos return a real waveform,
geo-restricted ones included:

| source | usable | geo-restricted | typical |
| --- | --- | --- | --- |
| Cloudflare worker | 7 / 12 | refused | ~2 s |
| Raspberry Pi at home | **12 / 12** | **works** | 3–19 s |

The app asks the worker where the Pi is, prefers it when it answers, and falls back to
the worker otherwise — so the worker is the floor, never a single point of failure.

It is deliberately not configured anywhere. A quick tunnel is issued a new hostname every
start, so the Pi announces its own address to the worker, which keeps it under a short
TTL. A restart, a reboot or a new WAN address is then just another announcement, and a Pi
that stops announcing disappears on its own.

Three things worth knowing, all of them learned the hard way:

- **cloudflared defaults to QUIC, which pegs an ARMv6 core.** The same transfer took
  172 s over QUIC and 14.7 s over `--protocol http2`.
- **A dropped edge connection retires the hostname**, but cloudflared reconnects the
  tunnel and keeps reporting itself healthy — the dead name then answers 530 forever. So
  the watchdog checks the *public* URL from outside rather than the relay from inside, and
  drops the tunnel to earn a fresh name.
- **Cloudflare answers urllib's default user agent with a 1010** before the request
  reaches the worker, so the announcement has to look like a browser.

```bash
cd pi
LOOPTUBE_SECRET=<the worker's REGISTER_SECRET> bash install.sh
```

Standard library only — no pip, no Node. It runs on a 2012 Raspberry Pi Model B.

### If the proxy cannot reach a video

Nothing breaks. The video still plays and A–B repeat, markers and tempo all still work —
the waveform falls back to a flat bed, pitch is greyed out because the iframe cannot do
it, and the app says which of the two reasons applied. You can load the audio from a
local file in settings to get the full engine back.

## Stem separation

The worker also splits a track into stems (vocals, bass, drums, guitars, piano, …),
driven through Moises' own studio API on a Premium account whose credentials live only as
worker secrets. It is metered by that subscription, so there is no per-use cost.

```
POST /stems  {"v":"<id>","stems":["vocals","drums","bass"],"name":"…"}  -> {"taskId":"…"}
GET  /stems?taskId=<id>   -> {"status":"STARTED"} … {"status":"COMPLETED","stems":{…}}
```

The worker resolves the source the same way `/audio` does — same resolver, same Pi
fallback for geo-restricted videos — pulls it once, and hands it to Moises. At most five
stems per request (the residual `other` is added on top). The returned URLs are Moises'
own CDN: public, CORS-`*`, range-serving and immutable, so the browser fetches and caches
them directly and no stem audio passes back through the worker. Auth is an email+password
sign-in cached as a short-lived token in KV; set it with:

```
wrangler secret put MOISES_EMAIL
wrangler secret put MOISES_PASSWORD
```

## Layout

```
src/               the app (Vue 3 + Vite, static, no backend)
  composables/
    useAudioEngine.ts     vendored from asla — Web Audio + soundtouchjs
    useYouTubePlayer.ts   the IFrame player wearing the same interface
  components/
    WaveformCanvas.vue    vendored from asla
    JogStrip.vue          vendored from asla
worker/            the Cloudflare Worker: resolves and relays audio, and holds the
                   registration of whichever home relay is currently up
pi/                the same relay for a machine at home, plus its tunnel and units
docs/              the built site, served by GitHub Pages
```

Both backends satisfy one `Transport` interface, so a single set of controls drives
either. A `can` field says what the current one cannot do, and the UI greys that out
rather than pretending it worked — YouTube playback has no pitch control and cannot
boost above unity.

## Develop

```bash
npm install
npm run dev
```

```bash
npm test
```

### Measuring sync

The waveform, the muted video and the sound all have to agree with each other, and none of
that is visible in a screenshot, so it is measured:

```bash
npm run dev
node scripts/__test-sync-collector.mjs
```

then open `/looptube/__test-sync-lab.html` and press run — or, headlessly, launch Chrome
with `--autoplay-policy=no-user-gesture-required` at
`/looptube/__test-sync-lab.html?auto=1&post=http://localhost:8899/`.

The lab plays a generated track carrying one tone burst per whole second, each at its own
pitch, so a burst names the second it belongs to however the time-stretcher has mangled
the spacing. `public/__test-sync-tap.js` reports from the **audio thread** when each burst
actually reached the graph; the page compares that against what the playhead read at the
same instant. A positive `atSpeakerMs` means the playhead runs ahead of the sound.

`/looptube/__test-yt-rate.html` asks the iframe player which playback rates it really
honours, as opposed to the ladder it advertises. `npm test` covers the video-follow
arithmetic on its own.

The PWA icons are generated rather than checked in as art nobody can edit:

```bash
node scripts/icons.mjs
```

## Deploy

The site builds into `docs/`, which GitHub Pages serves from the default branch:

```bash
npm run deploy
```

The worker deploys separately:

```bash
cd worker && npx wrangler deploy
```

Point the app at your own worker under the gear icon; it defaults to the deployed one.

## Caveats

- The resolver is a third party. If it goes down, waveforms go with it — the worker keeps
  a list of resolvers so another can be slotted in, and the app degrades rather than fails.
  Everything else was tried: Invidious and Piped are dead for streams, cobalt needs a
  captcha-issued token, and the transcoding services that host media themselves answer
  "Access blocked" to datacenter requests.
- Very long videos may exceed the Worker subrequest budget, since the audio is pulled in
  chunks. Songs are fine; a three-hour livestream is not.
- Playback stays on the iframe's own audio — which can never be out of step with the
  picture — and only moves to the Web Audio engine for what the iframe cannot do: pitch
  shifting, boosting past unity, rates outside 0.25–2x, a stem blend, or a file that is
  not this video's audio. It hands back as soon as none of that is asked for.
- While the engine does have the floor, the muted picture is kept with it by running a
  shade fast or slow rather than by being seeked, since every seek flickers the player's
  own controls. Above 2x the player runs out of rate and cannot keep up at all, so there
  it does get seeked, about once a second. The waveform stays exact either way.
- Only extraction is proxied. Playback stays in YouTube's own embedded player, so views
  and ads are served normally.
