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
