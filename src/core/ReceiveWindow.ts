/** Bounded 16-bit receive window shared by the three Icom UDP streams. */
export class ReceiveWindow {
  private next = 0;
  private readonly pending = new Map<number, Buffer>();
  private gapSince: number | undefined;
  private requestedAt = -Infinity;
  private requests = 0;

  constructor(private readonly deliver: (packet: Buffer) => void,
              private readonly request: (sequences: number[]) => void,
              private readonly holdMs = 100) {}

  reset() {
    this.next = 0;
    this.pending.clear();
    this.gapSince = undefined;
    this.requests = 0;
    this.requestedAt = -Infinity;
  }

  receive(sequence: number, packet: Buffer, now: number) {
    const distance = (sequence - this.next + 0x10000) & 0xffff;
    if (distance >= 0x8000) return; // Delivered duplicate or late retransmission.
    if (distance > 256) {
      // A large forward discontinuity is not a request for thousands of packets.
      this.reset();
      this.next = sequence;
    }
    if (!this.pending.has(sequence)) this.pending.set(sequence, Buffer.from(packet));
    this.flush(now);
  }

  tick(now: number) {
    if (this.gapSince === undefined) return;
    if (now - this.gapSince >= this.holdMs) {
      const first = [...this.pending.keys()].sort((a, b) =>
        ((a - this.next + 0x10000) & 0xffff) - ((b - this.next + 0x10000) & 0xffff))[0];
      if (first !== undefined) this.next = first;
      this.flush(now);
    } else if (this.requests < 3 && now - this.requestedAt >= 25) {
      const end = [...this.pending.keys()].sort((a, b) =>
        ((a - this.next + 0x10000) & 0xffff) - ((b - this.next + 0x10000) & 0xffff))[0];
      const missing: number[] = [];
      for (let seq = this.next; seq !== end && missing.length < 256; seq = (seq + 1) & 0xffff) {
        missing.push(seq);
      }
      if (missing.length) this.request(missing);
      this.requestedAt = now;
      this.requests++;
    }
  }

  private flush(now: number) {
    let packet: Buffer | undefined;
    while ((packet = this.pending.get(this.next))) {
      this.pending.delete(this.next);
      this.next = (this.next + 1) & 0xffff;
      this.deliver(packet);
    }
    if (this.pending.size === 0) {
      this.gapSince = undefined;
      this.requests = 0;
    } else if (this.gapSince === undefined) {
      this.gapSince = now;
      this.requests = 0;
      this.requestedAt = -Infinity;
    }
  }
}
