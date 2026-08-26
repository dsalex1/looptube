import type { LoopState } from '@/types'

const KEY = (id: string) => `looptube:${id}`

export const emptyState = (): LoopState => ({ markers: [], loopA: null, loopB: null, tempo: 1, pitch: 0, gainDb: 0 })

const num = (v: string | null) => (v == null || v === '' ? null : Number.isFinite(+v) ? +v : null)

/** Round-trip seconds compactly; the hash is meant to be pasted into a chat window. */
const secs = (n: number) => +n.toFixed(2)

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
    return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState()
  } catch {
    return emptyState()
  }
}

/** Everything needed to reproduce a marked-up video, small enough to be a link. */
export function toHash(id: string, state: LoopState) {
  const p = new URLSearchParams({ v: id })
  if (state.loopA != null) p.set('a', String(secs(state.loopA)))
  if (state.loopB != null) p.set('b', String(secs(state.loopB)))
  if (state.markers.length) p.set('m', state.markers.map(secs).join(','))
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
  state.markers = (p.get('m') ?? '').split(',').map(Number).filter(Number.isFinite)
  state.tempo = num(p.get('t')) ?? 1
  state.pitch = num(p.get('p')) ?? 0
  return { id, state }
}
