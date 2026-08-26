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
- **State per video** in `localStorage`, plus a shareable permalink

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

Measured over 12 videos: **7 give a real waveform, 5 are geo-restricted.** The
geo-restricted ones skew towards major-label music, which is unfortunate for a practice
tool — for those, load the audio from a file and everything works.

### If the proxy cannot reach a video

Nothing breaks. The video still plays and A–B repeat, markers and tempo all still work —
the waveform falls back to a flat bed, pitch is greyed out because the iframe cannot do
it, and the app says which of the two reasons applied. You can load the audio from a
local file in settings to get the full engine back.

## Layout

```
src/               the app (Vue 3 + Vite, static, no backend)
  composables/
    useAudioEngine.ts     vendored from asla — Web Audio + soundtouchjs
    useYouTubePlayer.ts   the IFrame player wearing the same interface
  components/
    WaveformCanvas.vue    vendored from asla
    JogStrip.vue          vendored from asla
worker/            the Cloudflare Worker that resolves and relays audio
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
- Only extraction is proxied. Playback stays in YouTube's own embedded player, so views
  and ads are served normally.
