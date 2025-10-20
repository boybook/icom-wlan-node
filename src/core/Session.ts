import { UdpClient } from '../transport/UdpClient';
import { dbgV } from '../utils/debug';
import { Cmd, ControlPacket, PingPacket, TokenType } from './IcomPackets';

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
  private txHistory = new Map<number, Buffer>();
  private areYouThereTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;

  private destroyed = false;

  constructor(address: SessionOptions, handlers: SessionHandlers) {
    this.address = address;
    this.udp.on('data', (rinfo, data) => {
      if (this.destroyed) return;
      this.lastReceivedTime = Date.now();
      try {
        // Peek type directly to avoid late requires during teardown
        const t = data.length >= 6 ? data.readUInt16LE(4) : -1;
        dbgV(`RX port=${this.localPort} from ${rinfo.address}:${rinfo.port} len=${data.length} type=${t >= 0 ? '0x'+t.toString(16) : 'n/a'}`);
      } catch {}
      handlers.onData(data);
    });
    this.udp.on('error', handlers.onSendError);
  }

  open() { this.udp.open(); }
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
    this.areYouThereTimer = setInterval(() => {
      dbgV(`AYT -> ${this.address.ip}:${this.address.port} localId=${this.localId}`);
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
}
