import type { Loop, LoopState, Marker } from '@/types'

const KEY = (id: string) => `looptube:${id}`

export const emptyState = (): LoopState => ({ markers: [], loops: [], loopA: null, loopB: null, tempo: 1, pitch: 0, gainDb: 0 })

/** state written before markers were named carries bare positions */
const asMarker = (m: number | Marker): Marker => (typeof m === 'number' ? { at: m } : m)

const num = (v: string | null) => (v == null || v === '' ? null : Number.isFinite(+v) ? +v : null)

/** Round-trip seconds compactly; the hash is meant to be pasted into a chat window. */
const secs = (n: number) => +n.toFixed(2)

// A marker is `[!]at[~name]`, a loop `a-b[~name]`; the ! marks a skip. The name is escaped
// so that a comma or a tilde typed into it cannot break the list apart.
const parts = (raw: string | null) => (raw ? raw.split(',') : [])
const tag = (name?: string) => (name ? `~${encodeURIComponent(name)}` : '')
const named = (raw?: string) => (raw ? { name: decodeURIComponent(raw) } : {})
// only the first tilde separates: encodeURIComponent leaves one typed into a name alone
const split = (raw: string): [string, string?] => {
  const at = raw.indexOf('~')
  return at < 0 ? [raw] : [raw.slice(0, at), raw.slice(at + 1)]
}

const writeMarker = (m: Marker) => `${m.skip ? '!' : ''}${secs(m.at)}${tag(m.name)}`
const writeLoop = (l: Loop) => `${secs(l.a)}-${secs(l.b)}${tag(l.name)}`

function readMarker(raw: string): Marker {
  const [at, name] = split(raw)
  const skip = at.startsWith('!')
  return { at: Number(skip ? at.slice(1) : at), ...(skip ? { skip: true } : {}), ...named(name) }
}

function readLoop(raw: string): Loop | null {
  const [bounds, name] = split(raw)
  const [a, b] = bounds.split('-').map(Number)
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? { a, b, ...named(name) } : null
}

export function save(id: string, state: LoopState) {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(state))
  } catch {
    /* private mode, or full: the app still works, it just forgets */
  }
}

export function load(id: string): LoopState {
  try {
    const raw = localStorage.getItem(KEY(id))
    if (!raw) return emptyState()
    const state: LoopState = { ...emptyState(), ...JSON.parse(raw) }
    return { ...state, markers: state.markers.map(asMarker) }
  } catch {
    return emptyState()
  }
}

/** Everything needed to reproduce a marked-up video, small enough to be a link. */
export function toHash(id: string, state: LoopState) {
  const p = new URLSearchParams({ v: id })
  if (state.loopA != null) p.set('a', String(secs(state.loopA)))
  if (state.loopB != null) p.set('b', String(secs(state.loopB)))
  if (state.markers.length) p.set('m', state.markers.map(writeMarker).join(','))
  if (state.loops.length) p.set('l', state.loops.map(writeLoop).join(','))
  if (state.tempo !== 1) p.set('t', String(state.tempo))
  if (state.pitch !== 0) p.set('p', String(state.pitch))
  return `#${p}`
}

export function fromHash(hash: string): { id: string; state: LoopState } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''))
  const id = p.get('v')
  if (!id) return null
  const state = emptyState()
  state.loopA = num(p.get('a'))
  state.loopB = num(p.get('b'))
  state.markers = parts(p.get('m')).map(readMarker).filter((m) => Number.isFinite(m.at))
  state.loops = parts(p.get('l')).map(readLoop).filter((l): l is Loop => !!l)
  state.tempo = num(p.get('t')) ?? 1
  state.pitch = num(p.get('p')) ?? 0
  return { id, state }
}
