import dgram from 'dgram';
import { EventEmitter } from 'events';

export interface UdpClientEvents {
  data: (rinfo: dgram.RemoteInfo, data: Buffer) => void;
  error: (err: Error) => void;
}

export class UdpClient extends EventEmitter {
  private socket?: dgram.Socket;
  private opening?: Promise<void>;
  private cancelOpen?: () => void;
  private _localPort = 0;
  public get localPort(): number { return this._localPort; }

  open(localPort = 0): Promise<void> {
    if (this.opening) return this.opening;
    if (this.socket) return Promise.resolve();
    const sock = dgram.createSocket('udp4');
    this.socket = sock;
    sock.on('message', (msg, rinfo) => {
      if (this.socket === sock) this.emit('data', rinfo, Buffer.from(msg));
    });
    sock.on('error', err => {
      if (this.socket === sock) this.emit('error', err);
    });
    this.opening = new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { sock.off('error', fail); this.cancelOpen = undefined; };
      this.cancelOpen = () => fail(new Error('UDP bind cancelled'));
      sock.once('error', fail);
      sock.bind(localPort, () => {
        if (this.socket !== sock) return;
        cleanup();
        const address = sock.address();
        if (typeof address === 'object') this._localPort = address.port;
        resolve();
      });
    }).finally(() => { if (this.socket === sock) this.opening = undefined; });
    return this.opening;
  }

  close() {
    const sock = this.socket;
    this.cancelOpen?.();
    this.socket = undefined;
    this.opening = undefined;
    this._localPort = 0;
    if (sock) {
      try { sock.close(); } catch { /* Already closed or bind failed. */ }
    }
  }

  send(buf: Buffer, ip: string, port: number) {
    const sock = this.socket;
    if (!sock) throw new Error('UDP socket not opened');
    sock.send(buf, port, ip, err => {
      if (err && this.socket === sock) this.emit('error', err);
    });
  }
}
