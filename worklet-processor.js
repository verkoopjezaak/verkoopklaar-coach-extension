// worklet-processor.js
// PCM16 AudioWorkletProcessor met source-labeling voor de Chrome extensie.
// Identiek aan public/coach-pcm-worklet-labeled.js in de web-app.
// Gekopieerd naar chrome-extension/ want MV3 staat geen remote code toe.
// source: 0x01 = advisor (mic), 0x02 = client (tab-audio)

class PCMLabeledWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.sourceLabel = (options.processorOptions && options.processorOptions.sourceLabel) || 0x01;
    this.targetSampleRate = 16000;
    this.inputSampleRate = sampleRate;
    this.ratio = this.inputSampleRate / this.targetSampleRate;
    this.buffer = [];
    this.chunkSamples = 1600; // 100ms @ 16kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i += this.ratio) {
      let sum = 0;
      let count = 0;
      const end = Math.min(Math.floor(i + this.ratio), channel.length);
      for (let j = Math.floor(i); j < end; j++) {
        sum += channel[j];
        count++;
      }
      this.buffer.push(count > 0 ? sum / count : 0);
    }

    while (this.buffer.length >= this.chunkSamples) {
      const chunk = this.buffer.splice(0, this.chunkSamples);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Stuur source-label mee zodat offscreen.js het frame kan prefixen
      this.port.postMessage(
        { source: this.sourceLabel, buffer: pcm16.buffer },
        [pcm16.buffer]
      );
    }
    return true;
  }
}

registerProcessor('coach-pcm-worklet-labeled', PCMLabeledWorkletProcessor);
