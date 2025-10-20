import dgram from 'dgram';
import { EventEmitter } from 'events';

export interface UdpClientEvents {
  data: (rinfo: dgram.RemoteInfo, data: Buffer) => void;
  error: (err: Error) => void;
}

export class UdpClient extends EventEmitter {
  private socket?: dgram.Socket;
  private _localPort = 0;
  public get localPort(): number { return this._localPort; }

  open(localPort?: number) {
    if (this.socket) return;
    this.socket = dgram.createSocket('udp4');
    const sock = this.socket;
    sock.on('message', (msg, rinfo) => this.emit('data', rinfo, Buffer.from(msg)));
    sock.on('error', (err) => this.emit('error', err));
    sock.bind(localPort ?? 0, () => {
      if (!sock) return;
      const addr = sock.address();
      if (typeof addr === 'object') this._localPort = addr.port;
    });
  }

  close() {
    if (!this.socket) return;
    try { this.socket.close(); } finally { this.socket = undefined; this._localPort = 0; }
  }

  send(buf: Buffer, ip: string, port: number) {
    if (!this.socket) throw new Error('UDP socket not opened');
    this.socket.send(buf, port, ip);
  }
}
