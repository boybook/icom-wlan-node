import { AUDIO_SAMPLE_RATE, AudioPacket, TX_BUFFER_SIZE } from '../core/IcomPackets';
import { dbgV } from '../utils/debug';
import { Session } from '../core/Session';

export class IcomAudio {
  private sendSeq = 0;
  private sendSeqForTiming = 0;  // Separate counter for drift compensation
  public isPttOn = false;
  private delayTimer?: NodeJS.Timeout;
  private generation = 0;
  public queue: Int16Array[] = [];  // Public for PTT control to clear queue
  private volume = 1.0; // 0.0 ~ 2.0
  private running = false;
  private startTime = 0;  // Absolute start time for drift compensation
  private readonly FRAME_INTERVAL_MS = 20;
  private frameCount = 0;
  private debugInterval = 0;
  private debugIntervalStart = 0;

  constructor(private sess: Session) {}

  start() {
    // Start continuous audio transmission with drift compensation
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.sendSeq = 0;
    this.startTime = performance.now();
    this.sendSeqForTiming = 0;
    this.frameCount = 0;
    this.debugInterval = 0;
    this.debugIntervalStart = 0;
    this.scheduleSend();
  }

  private scheduleSend(generation = this.generation) {
    if (!this.running || generation !== this.generation) return;
    const now = performance.now();
    let due = this.startTime + (this.sendSeqForTiming + 1) * this.FRAME_INTERVAL_MS;
    if (now - due > 100) {
      this.queue.splice(0, Math.min(this.queue.length, Math.floor((now - due) / this.FRAME_INTERVAL_MS)));
      this.startTime = now - (this.sendSeqForTiming + 1) * this.FRAME_INTERVAL_MS;
      due = now;
    }
    if (now >= due) {
      this.sendFrame();
      this.sendSeqForTiming++;
    }
    const next = this.startTime + (this.sendSeqForTiming + 1) * this.FRAME_INTERVAL_MS;
    this.delayTimer = setTimeout(() => this.scheduleSend(generation), Math.max(1, Math.ceil(next - performance.now())));
  }

  private sendFrame() {
    let frame: Int16Array;
    const hasData = this.queue.length > 0;

    if (hasData) {
      // Send audio from queue when available
      frame = this.queue.shift()!;
    } else {
      // Send silence when queue is empty
      frame = new Int16Array(TX_BUFFER_SIZE);
    }

    const buf = Buffer.alloc(TX_BUFFER_SIZE * 2);
    for (let i = 0; i < TX_BUFFER_SIZE; i++) buf.writeInt16LE(frame[i] ?? 0, i * 2);
    const pkt = AudioPacket.getTxAudioPacket(buf, 0, this.sess.localId, this.sess.remoteId, this.sendSeq);
    this.sendSeq = (this.sendSeq + 1) & 0xffff;
    this.sess.sendTracked(pkt);

    // Debug: log timing info every 50 frames (~1 second)
    this.frameCount++;
    if (this.frameCount % 50 === 0) {
      const now = performance.now();
      if (this.debugIntervalStart > 0) {
        const elapsed = now - this.debugIntervalStart;
        const avgInterval = elapsed / 50;
        const drift = elapsed - (50 * this.FRAME_INTERVAL_MS);
        dbgV(`[AudioTiming] Avg: ${avgInterval.toFixed(2)}ms (target: ${this.FRAME_INTERVAL_MS}ms), drift: ${drift.toFixed(2)}ms, queue: ${this.queue.length}`);
      }
      this.debugIntervalStart = now;
    }
  }

  stop() {
    // Stop continuous audio transmission (only on disconnect)
    this.running = false;
    this.generation++;
    if (this.delayTimer) clearTimeout(this.delayTimer);
    this.delayTimer = undefined;
    this.queue.length = 0;
    this.isPttOn = false;
    this.frameCount = 0;
    this.debugInterval = 0;
  }

  // Add leading silence frames (like Java's front buffer)
  private addLeadingSilence(frameCount: number = 3) {
    const silence = new Int16Array(TX_BUFFER_SIZE);
    for (let i = 0; i < frameCount; i++) {
      this.queue.push(silence);
    }
  }

  // Add trailing silence frames (like Java's tail buffer)
  private addTrailingSilence(frameCount: number = 5) {
    const silence = new Int16Array(TX_BUFFER_SIZE);
    for (let i = 0; i < frameCount; i++) {
      this.queue.push(silence);
    }
  }

  // Push Float32 samples; they will be converted to 16-bit and sliced into 20ms frames
  enqueueFloat32(samples: Float32Array, addLeadingBuffer: boolean = false) {
    // Add leading silence buffer if requested (used at PTT start)
    if (addLeadingBuffer && this.queue.length === 0) {
      this.addLeadingSilence(3);
    }

    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let x = Math.max(-1, Math.min(1, samples[i]));
      out[i] = (x * this.volume * 32767) | 0;
    }
    this.enqueuePcm16(out);
  }

  enqueuePcm16(samples: Int16Array) {
    // slice into TX_BUFFER_SIZE frames
    for (let i = 0; i < samples.length; i += TX_BUFFER_SIZE) {
      const slice = samples.subarray(i, Math.min(samples.length, i + TX_BUFFER_SIZE));
      // Always create a new buffer to avoid issues with subarray views
      const frame = new Int16Array(TX_BUFFER_SIZE);
      frame.set(slice);
      this.queue.push(frame);
    }
  }

  setVolume(multiplier: number) { this.volume = Math.max(0, multiplier); }
}

export const AUDIO_RATE = AUDIO_SAMPLE_RATE;
