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

/** the shape SimpleFilter pulls its input through, minus the AudioBuffer we cannot have here */
class ChannelSource {
  constructor(channels) {
    this.channels = channels
    this.length = channels[0].length
  }

  extract(target, numFrames, position) {
    const left = this.channels[0]
    const right = this.channels[1] || this.channels[0]
    const available = Math.max(0, Math.min(numFrames, this.length - position))
    for (let i = 0; i < available; i++) {
      target[i * 2] = left[position + i]
      target[i * 2 + 1] = right[position + i]
    }
    return available
  }
}

class SoundTouchProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super()
    this.pipe = new SoundTouch()
    this.pipe.tempo = processorOptions.tempo
    this.pipe.pitchSemitones = processorOptions.pitch
    this.filter = null
    // the track is handed over separately, so its channels can be transferred rather than copied
    this.playing = false
    this.ended = false
    this.interleaved = new Float32Array(128 * 2)
    this.port.onmessage = ({ data }) => this.receive(data)
  }

  receive(data) {
    if (data.channels) {
      this.filter = new SimpleFilter(new ChannelSource(data.channels), this.pipe)
      this.filter.sourcePosition = data.startFrame
    }
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
