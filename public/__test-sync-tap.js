/**
 * Sync harness tap (see __test-sync-lab.html).
 *
 * Sits after the shifter and reports, on the audio thread, the context time at which each
 * marker burst of the test track actually reached the graph - plus the burst's frequency,
 * which is how the harness knows *which* marker it just heard without having to trust a
 * count that a time-stretcher is free to duplicate or drop.
 *
 * It runs on the audio thread on purpose: what is being measured is how far the main
 * thread's playhead has wandered from the audio, so the measurement must not share its fate.
 */
const THRESHOLD = 0.02
const REARM_SECONDS = 0.15 // silence this long ends a burst and arms the next onset
const MAX_CROSSINGS = 512

class SyncTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.silent = 1e9
    this.armed = true
    this.previous = 0
    this.onset = 0 // context time of the burst being measured
    this.crossings = new Float64Array(MAX_CROSSINGS)
    this.count = 0
  }

  /**
   * A finished burst: where it started, and the pitch that names it. The period is taken
   * as a median rather than an average over the whole burst, because a time-stretcher
   * splices its overlaps mid-burst and each splice costs or invents a crossing - a mean
   * would carry those, a median shrugs them off.
   */
  flush() {
    if (this.count >= 5) {
      const periods = []
      for (let i = 1; i < this.count; i++) periods.push(this.crossings[i] - this.crossings[i - 1])
      periods.sort((a, b) => a - b)
      this.port.postMessage({ onset: this.onset, hz: 1 / periods[periods.length >> 1] })
    }
    this.count = 0
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    const output = outputs[0]?.[0]
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]
      if (output) output[i] = sample
      const at = currentTime + i / sampleRate

      if (Math.abs(sample) < THRESHOLD) {
        if (++this.silent > sampleRate * REARM_SECONDS && !this.armed) {
          this.flush()
          this.armed = true
        }
      } else {
        if (this.armed) {
          this.armed = false
          this.onset = at
        }
        this.silent = 0
      }
      // every sample, loud or not: the crossings themselves are quiet by definition, so
      // looking for them only in the loud stretches is looking everywhere but at them
      if (!this.armed && this.previous <= 0 && sample > 0 && this.count < MAX_CROSSINGS)
        this.crossings[this.count++] = at
      this.previous = sample
    }
    return true
  }
}

registerProcessor('sync-tap', SyncTap)
