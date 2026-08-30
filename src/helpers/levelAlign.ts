import { PEAKS_PER_SECOND } from './audioPeaks'

export type Reading = { at: number; level: number }

/**
 * How far the measured signal is running behind the playhead, in track seconds.
 *
 * The delay comes from the output buffer and, when a capo or a tempo is on, from the
 * stretcher's own block: it depends on the device and how busy the page is, so it
 * cannot be assumed. What it can be measured against is the signal ahead of the
 * limiter, which is just the source scaled by the gain and so has a shape we already
 * know. Sliding the readings against the stored peaks and taking the best match gives
 * the offset without having to guess at it.
 *
 * Pearson correlation, so the gain cancels out and only the shape is compared.
 */
export function estimateLag(readings: Reading[], peaks: Uint8Array, maxLag = 2, step = 0.01) {
  let best = { lag: 0, score: -1 }
  for (let lag = 0; lag <= maxLag; lag += step) {
    let n = 0
    let sumA = 0
    let sumB = 0
    let sumAA = 0
    let sumBB = 0
    let sumAB = 0
    for (const { at, level } of readings) {
      const index = Math.round((at - lag) * PEAKS_PER_SECOND)
      if (index < 0 || index >= peaks.length) continue
      const source = peaks[index] / 255
      n++
      sumA += level
      sumB += source
      sumAA += level * level
      sumBB += source * source
      sumAB += level * source
    }
    if (n < 20) continue
    const spread = Math.sqrt((n * sumAA - sumA * sumA) * (n * sumBB - sumB * sumB))
    if (!spread) continue // a stretch of silence says nothing about the offset
    const score = (n * sumAB - sumA * sumB) / spread
    if (score > best.score) best = { lag, score }
  }
  return best
}
