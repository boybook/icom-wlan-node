import type { RigEventEmitter } from '../types';

export class CivCommandRejectedError extends Error {
  readonly name = 'CivCommandRejectedError';
  constructor(public readonly command: string) { super(`ICOM CI-V command rejected: ${command}`); }
}

export interface CivQueryOptions {
  key: string;
  predicate: (frame: Buffer) => boolean;
  rejectPredicate?: (frame: Buffer) => boolean;
  timeoutMs: number;
  abortQueueOnTimeout?: boolean;
  send: () => void;
}
interface InflightRequest {
  options: CivQueryOptions;
  promise: Promise<Buffer | null>;
  resolve: (frame: Buffer | null) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}

/** CI-V ACK/NAK has no transaction ID: only one request may own the reply stream. */
export class IcomCivRequestManager {
  private pending = new Map<string, InflightRequest>();
  private active?: InflightRequest;
  private readonly onFrameBound = (frame: Buffer) => this.onFrame(frame);
  constructor(private readonly events: RigEventEmitter) { events.on('civFrame', this.onFrameBound); }

  query(options: CivQueryOptions): Promise<Buffer | null> {
    const existing = this.pending.get(options.key);
    if (existing) return existing.promise;
    let resolve!: InflightRequest['resolve'], reject!: InflightRequest['reject'];
    const promise = new Promise<Buffer | null>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(options.key, { options, promise, resolve, reject });
    this.pump();
    return promise;
  }

  cancelPending(error = new Error('ICOM session ended')) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.active = undefined;
    for (const entry of entries) { clearTimeout(entry.timer); entry.reject(error); }
  }

  dispose() { this.events.off('civFrame', this.onFrameBound); this.cancelPending(); }
  getPendingCount(): number { return this.pending.size; }

  private pump() {
    if (this.active) return;
    const entry = this.pending.values().next().value as InflightRequest | undefined;
    if (!entry) return;
    this.active = entry;
    entry.timer = setTimeout(() => {
      this.finish(entry, null);
      if (entry.options.abortQueueOnTimeout) this.cancelPending(new Error('ICOM write acknowledgement timeout'));
    }, entry.options.timeoutMs);
    try { entry.options.send(); } catch (error) { this.finish(entry, null, error); }
  }

  private onFrame(frame: Buffer) {
    const entry = this.active;
    if (!entry) return;
    if (entry.options.rejectPredicate?.(frame)) this.finish(entry, null, new CivCommandRejectedError(entry.options.key));
    else if (entry.options.predicate(frame)) this.finish(entry, frame);
  }

  private finish(entry: InflightRequest, frame: Buffer | null, error?: unknown) {
    if (this.active !== entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(entry.options.key);
    this.active = undefined;
    if (error !== undefined) entry.reject(error); else entry.resolve(frame);
    // Give the owner's continuation a chance to cancel after a failed command.
    queueMicrotask(() => this.pump());
  }
}
