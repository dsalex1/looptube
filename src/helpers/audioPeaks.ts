/** Waveform peak data: one byte per bucket, 0..255 spanning silence to PEAK_CEILING_DB. */
export const PEAKS_PER_SECOND = 100

/**
 * How far above 0 dBFS a peak can still be recorded. A brickwalled master decodes past
 * full scale — the encoder never promised to stay under it — and clamping there flattens
 * every one of those peaks onto the same line, which reads as clipping however loud the
 * track actually is.
 */
export const PEAK_CEILING_DB = 2
export const PEAK_CEILING = 10 ** (PEAK_CEILING_DB / 20)

// only the parts of AudioBuffer we need, so this stays testable without Web Audio
type ChannelData = { numberOfChannels: number; length: number; sampleRate: number; getChannelData(i: number): Float32Array }

export function computePeaks(buffer: ChannelData, perSecond = PEAKS_PER_SECOND): Uint8Array {
  const samplesPerBucket = Math.max(1, Math.round(buffer.sampleRate / perSecond))
  const peaks = new Uint8Array(Math.ceil(buffer.length / samplesPerBucket))
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))

  for (let bucket = 0; bucket < peaks.length; bucket++) {
    const start = bucket * samplesPerBucket
    const end = Math.min(start + samplesPerBucket, buffer.length)
    let peak = 0
    for (const samples of channels)
      for (let i = start; i < end; i++) {
        const v = Math.abs(samples[i])
        if (v > peak) peak = v
      }
    peaks[bucket] = Math.min(255, Math.round((peak / PEAK_CEILING) * 255))
  }
  return peaks
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  return await ctx.decodeAudioData(data)
}

export const peakTime = (index: number, perSecond = PEAKS_PER_SECOND) => index / perSecond
export const peakIndex = (seconds: number, perSecond = PEAKS_PER_SECOND) => Math.round(seconds * perSecond)
