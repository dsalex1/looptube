import type { Ref } from 'vue'

/**
 * What the controls drive. Both backends satisfy it: the Web Audio engine vendored from
 * asla, and the YouTube player, which can only do a subset. `can` says which subset, so
 * the UI greys out what this source cannot do rather than pretending it worked.
 */
export interface Transport {
  currentTime: Ref<number>
  duration: Ref<number>
  playing: Ref<boolean>
  loading: Ref<boolean>
  error: Ref<string>
  tempo: Ref<number>
  pitch: Ref<number>
  gainDb: Ref<number>
  loopA: Ref<number | null>
  loopB: Ref<number | null>
  loopEnabled: Ref<boolean>
  play(): void
  pause(): void
  toggle(): void
  seek(seconds: number): void
  skip(seconds: number): void
  can: Capabilities
}

export interface Capabilities {
  /** independent pitch shift; YouTube time-stretches natively and offers no control */
  pitch: boolean
  /** boost above unity; YouTube's volume only attenuates */
  boost: boolean
  /** the range of playback rates this source can hold; the controls stop at the ends */
  tempoMin: number
  tempoMax: number
}

/** Everything worth keeping about one video, keyed by its id. */
export interface LoopState {
  markers: number[]
  loopA: number | null
  loopB: number | null
  tempo: number
  pitch: number
  gainDb: number
  title?: string
}

export type PaneView = 'video' | 'waveform'
