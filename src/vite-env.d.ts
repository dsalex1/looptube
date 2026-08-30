/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** build stamp injected by vite.config.ts (short commit · date) */
declare const __BUILD__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// the package ships JS only; this is the slice of its documented surface the engine uses
declare module 'signalsmith-stretch' {
  export interface StretchNode extends AudioWorkletNode {
    /** how far it has read into its input buffers; unused in live-input mode */
    readonly inputTime: number
    schedule(change: {
      output?: number
      active?: boolean
      rate?: number
      semitones?: number
      loopStart?: number
      loopEnd?: number
    }): Promise<unknown>
    start(when?: number): Promise<unknown>
    stop(when?: number): Promise<unknown>
    /** seconds it adds on the way through, in live-input mode */
    latency(): Promise<number>
  }
  export default function SignalsmithStretch(
    context: BaseAudioContext,
    options?: AudioWorkletNodeOptions
  ): Promise<StretchNode>
}

interface Window {
  YT: typeof YT
  onYouTubeIframeAPIReady?: () => void
}

// Undocumented but long-lived, and the only way to turn subtitles off from the API.
// @types/youtube ships the documented surface only, so it is declared here.
declare namespace YT {
  interface Player {
    unloadModule(module: string): void
  }
}
