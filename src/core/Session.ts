import { UdpClient } from '../transport/UdpClient';
import { dbg, dbgV } from '../utils/debug';
import { Cmd, ControlPacket, PingPacket, CivPacket } from './IcomPackets';
import { SessionType } from '../types';
import { randomBytes } from 'crypto';
import { be16, le16, le32 } from '../utils/codec';
import { ReceiveWindow } from './ReceiveWindow';

export interface SessionOptions {
  ip: string;
  port: number;
}

export interface SessionHandlers {
  onData: (data: Buffer) => void; // upstream raw packet observer
  onSendError: (err: Error) => void;
}

export class Session {
  public readonly udp = new UdpClient();
  public localId = Date.now() >>> 0;
  public remoteId = 0;
  public trackedSeq = 1; // 0x03 uses seq=0, 0x06 uses seq=1
  public pingSeq = 0;
  public innerSeq = 0x30;
  public rigToken = 0;
  public localToken = (Date.now() & 0xffff) >>> 0; // short semantics
  public lastSentTime = Date.now();
  public lastReceivedTime = Date.now();

  private address: SessionOptions;
  private handlers: SessionHandlers;
  private txHistory = new Map<number, { packet: Buffer; at: number }>();
  private receiveTimer?: NodeJS.Timeout;
  private readonly receiveWindow = new ReceiveWindow(
    packet => this.handlers.onData(packet), sequences => this.requestMissing(sequences));
  private areYouThereTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;

  private destroyed = false;

  // Session type identifier (set by IcomControl)
  public sessionType?: SessionType;

  constructor(address: SessionOptions, handlers: SessionHandlers) {
    this.address = address;
    this.handlers = handlers;
    this.udp.on('data', (rinfo, data: Buffer) => {
      if (this.destroyed || rinfo.address !== this.address.ip || rinfo.port !== this.address.port) return;
      if (data.length < 16 || data.length > 65507 || le32.read(data, 0) !== data.length) return;
      const type = ControlPacket.getType(data);
      const sender = ControlPacket.getSentId(data);
      const receiver = ControlPacket.getRcvdId(data);
      if (receiver !== this.localId || (this.remoteId !== 0 && sender !== this.remoteId)) return;
      if (![0, 1, 3, 4, 5, 6, 7].includes(type)) return;
      if (type === Cmd.PING && data.length !== 0x15) return;
      if (type === Cmd.RETRANSMIT && data.length !== 16 && (data.length - 16) % 4 !== 0) return;
      if (type === Cmd.NULL && data.length > 16) {
        if (this.sessionType === SessionType.CIV && data[0x10] === 0xc1 && !CivPacket.isCiv(data)) return;
        if (this.sessionType === SessionType.AUDIO && (data.length < 24 || data.length > 2072 || (data.length - 24) % 2 !== 0 ||
          be16.read(data, 0x16) !== data.length - 24)) return;
      }
      this.lastReceivedTime = Date.now();
      if (type === Cmd.RETRANSMIT) { this.handleRetransmit(data); return; }
      if (type === Cmd.NULL) {
        this.receiveWindow.receive(ControlPacket.getSeq(data), data, performance.now());
      } else {
        this.handlers.onData(data);
      }
    });
    this.udp.on('error', handlers.onSendError);
  }

  open() {
    this.destroyed = false;  // Reset destroyed flag to allow sending data after reconnection
    const ready = this.udp.open();
    if (!this.receiveTimer) this.receiveTimer = setInterval(() => this.receiveWindow.tick(performance.now()), 25);
    return ready;
  }
  close() {
    this.stopTimers();
    this.destroyed = true;
    this.udp.close();
    this.txHistory.clear();
    this.receiveWindow.reset();
  }

  get remoteAddress(): SessionOptions { return { ...this.address }; }

  get localPort(): number { return this.udp.localPort; }

  sendRaw(buf: Buffer) {
    if (this.destroyed) return;
    try {
      this.udp.send(buf, this.address.ip, this.address.port);
      this.lastSentTime = Date.now();
    } catch (error) { this.handlers.onSendError(error as Error); }
  }

  sendUntracked(buf: Buffer) { this.sendRaw(buf); }

  sendTracked(buf: Buffer) {
    const pkt = Buffer.from(buf);
    ControlPacket.setSeq(pkt, this.trackedSeq);
    this.sendRaw(pkt);
    const now = performance.now();
    this.purgeHistory(now);
    this.txHistory.set(this.trackedSeq, { packet: pkt, at: now });
    this.trackedSeq = (this.trackedSeq + 1) & 0xffff;
  }

  retransmit(seq: number) {
    this.purgeHistory(performance.now());
    const pkt = this.txHistory.get(seq);
    if (pkt) this.sendRaw(pkt.packet);
    else this.sendUntracked(ControlPacket.toBytes(Cmd.NULL, seq, this.localId, this.remoteId));
  }

  private purgeHistory(now: number) {
    for (const [seq, item] of this.txHistory) {
      if (now - item.at <= 3000 && this.txHistory.size < 2048) break;
      this.txHistory.delete(seq);
    }
  }

  handleRetransmit(packet: Buffer) {
    if (packet.length === 16) { this.retransmit(ControlPacket.getSeq(packet)); return; }
    // Icom range requests contain inclusive LE16 start/end pairs.
    let budget = 256;
    for (let i = 16; i + 3 < packet.length && budget > 0; i += 4) {
      const start = le16.read(packet, i), end = le16.read(packet, i + 2);
      const count = ((end - start + 0x10000) & 0xffff) + 1;
      if (count > budget) return;
      for (let n = 0; n < count; n++) this.retransmit((start + n) & 0xffff);
      budget -= count;
    }
  }

  private requestMissing(sequences: number[]) {
    if (!sequences.length || this.destroyed) return;
    if (sequences.length === 1) {
      this.sendUntracked(ControlPacket.toBytes(Cmd.RETRANSMIT, sequences[0], this.localId, this.remoteId));
      return;
    }
    const packet = Buffer.alloc(16 + sequences.length * 4);
    ControlPacket.toBytes(Cmd.RETRANSMIT, 0, this.localId, this.remoteId).copy(packet);
    le32.write(packet, 0, packet.length);
    sequences.forEach((seq, index) => {
      le16.write(packet, 16 + index * 4, seq);
      le16.write(packet, 18 + index * 4, seq);
    });
    this.sendUntracked(packet);
  }

  private idleTimer?: NodeJS.Timeout;
  startIdle() {
    this.stopIdle();
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastSentTime > 200) {
        this.sendTracked(ControlPacket.toBytes(Cmd.NULL, 0, this.localId, this.remoteId));
      }
    }, 100);
  }
  stopIdle() { if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; } }

  startAreYouThere() {
    this.stopAreYouThere();
    dbg(`Starting AreYouThere timer for ${this.address.ip}:${this.address.port}`);
    this.areYouThereTimer = setInterval(() => {
      dbg(`AYT -> ${this.address.ip}:${this.address.port} localId=${this.localId}`);
      this.sendUntracked(ControlPacket.toBytes(Cmd.ARE_YOU_THERE, 0, this.localId, 0));
    }, 500);
  }
  stopAreYouThere() { if (this.areYouThereTimer) { clearInterval(this.areYouThereTimer); this.areYouThereTimer = undefined; } }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.sendUntracked(PingPacket.buildPing(this.localId, this.remoteId, this.pingSeq));
    }, 500);
  }
  stopPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; } }

  stopTimers() { this.stopAreYouThere(); this.stopPing(); this.stopIdle();
    if (this.receiveTimer) clearInterval(this.receiveTimer);
    this.receiveTimer = undefined; }

  setRemote(ip: string, port: number) {
    this.address = { ip, port };
  }


  /**
   * Reset session state to initial values
   * Call this before reconnecting to ensure clean state
   * (especially important after radio restart)
   */
  resetState() {
    // Stop all timers to prevent leaks and interference with new connection
    this.stopTimers();

    // Reset destroyed flag to ensure session is usable after state reset
    this.destroyed = false;

    // Generate new IDs
    this.localId = le32.read(randomBytes(4), 0);
    this.remoteId = 0;

    // Reset sequence numbers
    this.trackedSeq = 1;
    this.pingSeq = 0;
    this.innerSeq = 0x30;

    // Reset tokens
    this.rigToken = 0;
    this.localToken = le16.read(randomBytes(2), 0);

    // Reset timestamps
    this.lastSentTime = Date.now();
    this.lastReceivedTime = Date.now();

    // Clear history
    this.txHistory.clear();
    this.receiveWindow.reset();

    dbgV(`Session state reset: localId=${this.localId}, localToken=${this.localToken}`);
  }
}
