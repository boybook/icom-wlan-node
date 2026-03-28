import { EventEmitter } from 'events';
import { IcomScopeFrame, IcomScopeSegmentInfo, IcomScopeTransport } from '../types';
import { parseScopeSegment } from './IcomScopeParser';

interface ScopeAssemblyState {
  receiver: 0 | 1;
  expectedMax: number;
  mode?: 0 | 1 | 2 | 3;
  startFreqHz?: number;
  endFreqHz?: number;
  outOfRange?: boolean;
  chunks: Uint8Array[];
  rawCivPayloads: Buffer[];
  updatedAt: number;
}

export interface IcomScopeServiceOptions {
  assemblyTimeoutMs?: number;
  freqLen?: number;
}

export class IcomScopeService extends EventEmitter {
  private readonly assemblyTimeoutMs: number;
  private readonly freqLen: number;
  private readonly assemblies = new Map<number, ScopeAssemblyState>();

  constructor(options?: IcomScopeServiceOptions) {
    super();
    this.assemblyTimeoutMs = options?.assemblyTimeoutMs ?? 500;
    this.freqLen = options?.freqLen ?? 5;
  }

  handleCivFrame(frame: Buffer, transport: IcomScopeTransport): IcomScopeFrame | null {
    const segment = parseScopeSegment(frame, transport, this.freqLen);
    if (!segment) return null;
    return this.handleScopeSegment(segment);
  }

  handleScopeSegment(segment: IcomScopeSegmentInfo): IcomScopeFrame | null {
    this.cleanupExpiredAssemblies();
    this.emit('scopeSegment', segment);

    const key = segment.receiver;
    const now = Date.now();

    if (segment.sequence === 1) {
      this.assemblies.set(key, {
        receiver: segment.receiver,
        expectedMax: segment.sequenceMax,
        mode: segment.mode,
        startFreqHz: segment.startFreqHz,
        endFreqHz: segment.endFreqHz,
        outOfRange: segment.outOfRange,
        chunks: segment.pixels ? [segment.pixels] : [],
        rawCivPayloads: [Buffer.from(segment.rawCivPayload)],
        updatedAt: now
      });
    } else {
      const state = this.assemblies.get(key);
      if (!state) return null;
      if (state.expectedMax !== segment.sequenceMax) {
        this.assemblies.delete(key);
        return null;
      }

      state.chunks.push(segment.pixels ?? new Uint8Array());
      state.rawCivPayloads.push(Buffer.from(segment.rawCivPayload));
      state.updatedAt = now;
    }

    const state = this.assemblies.get(key);
    if (!state) return null;
    if (segment.sequence !== state.expectedMax) return null;
    if (state.mode === undefined || state.startFreqHz === undefined || state.endFreqHz === undefined || state.outOfRange === undefined) {
      this.assemblies.delete(key);
      return null;
    }

    const pixels = this.concatChunks(state.chunks);
    const frame: IcomScopeFrame = {
      valid: true,
      receiver: state.receiver,
      sequence: segment.sequence,
      sequenceMax: state.expectedMax,
      mode: state.mode,
      outOfRange: state.outOfRange,
      startFreqHz: state.startFreqHz,
      endFreqHz: state.endFreqHz,
      pixels,
      rawCivPayloads: state.rawCivPayloads.map((payload) => Buffer.from(payload)),
      transport: segment.transport
    };

    this.assemblies.delete(key);
    this.emit('scopeFrame', frame);
    return frame;
  }

  async waitForScopeFrame(timeoutMs: number = 3000): Promise<IcomScopeFrame | null> {
    return new Promise<IcomScopeFrame | null>((resolve) => {
      let done = false;
      const onFrame = (frame: IcomScopeFrame) => {
        done = true;
        this.off('scopeFrame', onFrame);
        resolve(frame);
      };

      this.on('scopeFrame', onFrame);
      setTimeout(() => {
        if (done) return;
        this.off('scopeFrame', onFrame);
        resolve(null);
      }, timeoutMs);
    });
  }

  private cleanupExpiredAssemblies() {
    const now = Date.now();
    for (const [key, state] of this.assemblies.entries()) {
      if (now - state.updatedAt > this.assemblyTimeoutMs) {
        this.assemblies.delete(key);
      }
    }
  }

  private concatChunks(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
