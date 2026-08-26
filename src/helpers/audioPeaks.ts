/** Waveform peak data: one byte of 0..255 peak amplitude per bucket. */
export const PEAKS_PER_SECOND = 100

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
    peaks[bucket] = Math.min(255, Math.round(peak * 255))
  }
  return peaks
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, 44100)
  return await ctx.decodeAudioData(data)
}

export const peakTime = (index: number, perSecond = PEAKS_PER_SECOND) => index / perSecond
export const peakIndex = (seconds: number, perSecond = PEAKS_PER_SECOND) => Math.round(seconds * perSecond)
