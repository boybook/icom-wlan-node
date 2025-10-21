import { UdpClient } from '../transport/UdpClient';
import { dbg, dbgV } from '../utils/debug';
import { Cmd, ControlPacket, PingPacket, TokenType } from './IcomPackets';
import { SessionType, ConnectionMonitorConfig } from '../types';

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
  private txHistory = new Map<number, Buffer>();
  private areYouThereTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;

  private destroyed = false;

  // Session type identifier (set by IcomControl)
  public sessionType?: SessionType;

  constructor(address: SessionOptions, handlers: SessionHandlers) {
    this.address = address;
    this.handlers = handlers;
    this.udp.on('data', (rinfo, data) => {
      if (this.destroyed) return;
      this.lastReceivedTime = Date.now();

      try {
        const type = data.length >= 6 ? data.readUInt16LE(4) : -1;
        dbgV(`RX port=${this.localPort} from ${rinfo.address}:${rinfo.port} len=${data.length} type=${type >= 0 ? '0x'+type.toString(16) : 'n/a'}`);
      } catch {}
      handlers.onData(data);
    });
    this.udp.on('error', handlers.onSendError);
  }

  open() {
    this.destroyed = false;  // Reset destroyed flag to allow sending data after reconnection
    this.udp.open();
  }
  close() {
    this.stopTimers();
    this.destroyed = true;
    this.udp.close();
  }

  get localPort(): number { return this.udp.localPort; }

  sendRaw(buf: Buffer) {
    if (this.destroyed) return;
    try { this.udp.send(buf, this.address.ip, this.address.port); this.lastSentTime = Date.now(); } catch (e: any) { /* bubble via event */ }
  }

  sendUntracked(buf: Buffer) { this.sendRaw(buf); }

  sendTracked(buf: Buffer) {
    const pkt = Buffer.from(buf);
    ControlPacket.setSeq(pkt, this.trackedSeq);
    this.sendRaw(pkt);
    this.txHistory.set(this.trackedSeq, pkt);
    this.trackedSeq = (this.trackedSeq + 1) & 0xffff;
  }

  retransmit(seq: number) {
    const pkt = this.txHistory.get(seq);
    if (pkt) this.sendRaw(pkt);
    else this.sendUntracked(ControlPacket.toBytes(Cmd.NULL, seq, this.localId, this.remoteId));
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

  stopTimers() { this.stopAreYouThere(); this.stopPing(); this.stopIdle(); }

  setRemote(ip: string, port: number) {
    this.address = { ip, port };
  }


  /**
   * Reset session state to initial values
   * Call this before reconnecting to ensure clean state
   * (especially important after radio restart)
   */
  resetState() {
    // Reset destroyed flag to ensure session is usable after state reset
    this.destroyed = false;

    // Generate new IDs
    this.localId = Date.now() >>> 0;
    this.remoteId = 0;

    // Reset sequence numbers
    this.trackedSeq = 1;
    this.pingSeq = 0;
    this.innerSeq = 0x30;

    // Reset tokens
    this.rigToken = 0;
    this.localToken = (Date.now() & 0xffff) >>> 0;

    // Reset timestamps
    this.lastSentTime = Date.now();
    this.lastReceivedTime = Date.now();

    // Clear history
    this.txHistory.clear();

    dbgV(`Session state reset: localId=${this.localId}, localToken=${this.localToken}`);
  }
}
