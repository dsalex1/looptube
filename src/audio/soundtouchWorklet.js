import { SimpleFilter, SoundTouch } from 'soundtouchjs'

/**
 * SoundTouch, running on the audio thread.
 *
 * soundtouchjs ships its own PitchShifter, but that is built on a ScriptProcessorNode,
 * and Chrome zeroes a whole 128 frame render quantum whenever the audio thread cannot
 * take the main thread's lock (`output_buffer->Zero()` behind a TryLock, in Chromium's
 * ScriptProcessorNode.cpp). Because it is a race rather than a missed deadline, no
 * buffer size avoids it: measured on a quiet page it still punched an audible hole in
 * the output roughly once a second, while Firefox and this worklet measure clean.
 *
 * Only the node wrapper is replaced here - the filtering below is soundtouchjs's own.
 */

/**
 * The shape SimpleFilter pulls its input through. It holds every stem and a gain per
 * stem, and sums them as it is read: that is what lets a fader move in real time without
 * re-mixing anything on the main thread, since the gains are just a message away and the
 * one shifter downstream still does tempo and pitch on the blend. A plain track is simply
 * the one-stem case.
 */
class StemSource {
  constructor(stems, gains) {
    this.stems = stems // [{ left, right, length }]
    this.gains = gains // Float32Array, one per stem
    this.length = stems.reduce((m, s) => Math.max(m, s.length), 0)
  }

  extract(target, numFrames, position) {
    const available = Math.max(0, Math.min(numFrames, this.length - position))
    for (let i = 0; i < available * 2; i++) target[i] = 0 // we accumulate, so start silent
    for (let s = 0; s < this.stems.length; s++) {
      const g = this.gains[s]
      if (!g) continue
      const { left, right, length } = this.stems[s]
      for (let i = 0; i < available; i++) {
        const p = position + i
        if (p >= length) break
        target[i * 2] += g * left[p]
        target[i * 2 + 1] += g * right[p]
      }
    }
    return available
  }
}

const toStem = ([left, right]) => ({ left, right: right || left, length: left.length })

class SoundTouchProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super()
    this.pipe = new SoundTouch()
    this.pipe.tempo = processorOptions.tempo
    this.pipe.pitchSemitones = processorOptions.pitch
    this.filter = null
    this.source = null
    // the track is handed over separately, so its channels can be transferred rather than copied
    this.playing = false
    this.ended = false
    this.interleaved = new Float32Array(128 * 2)
    this.port.onmessage = ({ data }) => this.receive(data)
  }

  start(stems, gains, startFrame) {
    this.source = new StemSource(stems, gains)
    this.filter = new SimpleFilter(this.source, this.pipe)
    this.filter.sourcePosition = startFrame
    this.ended = false
  }

  receive(data) {
    // a plain track arrives as its two channels; a split one as an array of stems + gains
    if (data.channels) this.start([toStem(data.channels)], new Float32Array([1]), data.startFrame)
    if (data.stems) this.start(data.stems.map(toStem), Float32Array.from(data.gains), data.startFrame)
    // a fader move is just new gains — no re-mix, the next extract picks them up
    if (data.gains && this.source && !data.stems) this.source.gains = Float32Array.from(data.gains)
    if (data.tempo !== undefined) this.pipe.tempo = data.tempo
    if (data.pitch !== undefined) this.pipe.pitchSemitones = data.pitch
    if (data.playing !== undefined) this.playing = data.playing
    if (data.seekFrame !== undefined && this.filter) {
      this.filter.sourcePosition = data.seekFrame // this clears the pipe for us
      this.ended = false
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0]
    // outputs arrive zeroed, so staying quiet is just a matter of not writing
    if (!this.filter || !this.playing || this.ended) return true

    const frames = left.length
    if (this.interleaved.length < frames * 2) this.interleaved = new Float32Array(frames * 2)
    const extracted = this.filter.extract(this.interleaved, frames)

    if (extracted === 0) {
      this.ended = true
      this.port.postMessage({ ended: true })
      return true
    }
    for (let i = 0; i < extracted; i++) {
      left[i] = this.interleaved[i * 2]
      if (right) right[i] = this.interleaved[i * 2 + 1]
    }
    return true
  }
}

registerProcessor('soundtouch-processor', SoundTouchProcessor)
