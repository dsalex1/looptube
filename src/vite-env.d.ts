/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** build stamp injected by vite.config.ts (short commit · date) */
declare const __BUILD__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'soundtouchjs' {
  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize: number, onEnd?: () => void)
    tempo: number
    pitchSemitones: number
    percentagePlayed: number
    connect(node: AudioNode): void
    disconnect(): void
  }
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
