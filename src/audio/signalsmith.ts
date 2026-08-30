// as text, deliberately — see stretchFactory below
import stretchSource from 'signalsmith-stretch?raw'

/** the slice of Signalsmith Stretch's documented surface the engine uses; it ships no types */
export interface StretchNode extends AudioWorkletNode {
  schedule(change: { output?: number; active?: boolean; semitones?: number }): Promise<unknown>
  start(when?: number): Promise<unknown>
  /** seconds it adds on the way through, in live-input mode */
  latency(): Promise<number>
}

export type StretchFactory = (context: BaseAudioContext, options?: AudioWorkletNodeOptions) => Promise<StretchNode>

let factory: Promise<StretchFactory> | null = null

/**
 * Signalsmith has to reach the browser exactly as its author shipped it.
 *
 * It builds its worklet by stringifying its own source into a Blob, and the stringified
 * half closes over free variables that the wrapper rebinds *by name* — `_scriptName` among
 * them, written as literal text inside a template. A bundler renames the real identifiers
 * and cannot touch the text, so the two stop agreeing and the processor throws on load.
 *
 * Nothing surfaces when it does: `addModule` rejects, the node never arrives, and playback
 * carries on with the tempo applied and the pitch never put back. Two separate passes break
 * it: the dev dep optimiser lowers its class fields into `__publicField` helpers a worklet
 * scope has no definition for, and the production minifier renames `_scriptName`.
 *
 * So it is imported as raw text and run from a Blob of its own, where no pass can rewrite
 * it. Keep it that way: importing the package normally builds and looks fine, and only
 * fails once it is minified.
 */
export const stretchFactory = () =>
  (factory ??= import(
    /* @vite-ignore */ URL.createObjectURL(new Blob([stretchSource], { type: 'text/javascript' }))
  ).then((m) => m.default as StretchFactory))
