import type { RigEventEmitter } from '../types';

export interface CivQueryOptions {
  key: string;
  predicate: (frame: Buffer) => boolean;
  timeoutMs: number;
  send: () => void;
}

interface InflightRequest {
  promise: Promise<Buffer | null>;
  predicate: (frame: Buffer) => boolean;
  resolve: (frame: Buffer | null) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Deduplicates identical CI-V read queries while allowing different reply
 * signatures to wait concurrently on the shared civFrame stream.
 */
export class IcomCivRequestManager {
  private pending = new Map<string, InflightRequest>();
  private readonly onFrameBound = (frame: Buffer) => this.onFrame(frame);

  constructor(private readonly events: RigEventEmitter) {
    this.events.on('civFrame', this.onFrameBound);
  }

  query(options: CivQueryOptions): Promise<Buffer | null> {
    const existing = this.pending.get(options.key);
    if (existing) {
      return existing.promise;
    }

    let entry: InflightRequest;
    const promise = new Promise<Buffer | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(options.key) === entry) {
          this.pending.delete(options.key);
        }
        resolve(null);
      }, options.timeoutMs);

      entry = {
        promise: undefined as unknown as Promise<Buffer | null>,
        predicate: options.predicate,
        resolve,
        reject,
        timer,
      };
    });

    entry!.promise = promise;
    this.pending.set(options.key, entry!);

    try {
      options.send();
    } catch (err) {
      this.finish(options.key, entry!, null, err);
    }

    return promise;
  }

  dispose() {
    this.events.off('civFrame', this.onFrameBound);
    for (const [key, entry] of this.pending) {
      this.finish(key, entry, null);
    }
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private onFrame(frame: Buffer) {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.predicate(frame)) {
        this.finish(key, entry, frame);
      }
    }
  }

  private finish(key: string, entry: InflightRequest, frame: Buffer | null, err?: unknown) {
    if (this.pending.get(key) === entry) {
      this.pending.delete(key);
    }
    clearTimeout(entry.timer);
    if (err !== undefined) {
      entry.reject(err);
      return;
    }
    entry.resolve(frame);
  }
}
