import { IcomControl } from '../src/rig/IcomControl';
import { UdpClient } from '../src/transport/UdpClient';
import { Cmd, ControlPacket, CivPacket, Sizes, TokenType } from '../src/core/IcomPackets';
import { le16, le32, be16, be32 } from '../src/utils/codec';
import { resolveIcomProfile } from '../src/rig/IcomProfiles';

/** A protocol peer at the UDP boundary. Production owners/parsers are unchanged. */
class RadioPeer {
  sockets = new Map<UdpClient, { port: number; id: number }>();
  sequence = new Map<number, number>();
  history = new Map<string, Buffer>();
  writes: Buffer[] = [];
  open = new Set<UdpClient>();
  rejectLogin = false;
  holdAudio = false;
  nak = false;
  dropCivReplies = false;
  identity = 0xb6;
  dropLogin = false;
  dropped = false;
  constructor() {
    const peer = this;
    jest.spyOn(UdpClient.prototype, 'open').mockImplementation(async function(this: UdpClient) {
      peer.open.add(this);
      (this as any)._localPort = 40000 + peer.open.size;
    });
    jest.spyOn(UdpClient.prototype, 'close').mockImplementation(function(this: UdpClient) {
      peer.open.delete(this); (this as any)._localPort = 0;
    });
    jest.spyOn(UdpClient.prototype, 'send').mockImplementation(function(this: UdpClient, data, _ip, port) {
      peer.sockets.set(this, { port, id: ControlPacket.getSentId(data) });
      peer.sent(this, data, port);
    });
  }
  packet(socket: UdpClient, length: number, type = 0): Buffer {
    const { id, port } = this.sockets.get(socket)!;
    const b = Buffer.alloc(length);
    ControlPacket.toBytes(type, 0, port, id).copy(b);
    le32.write(b, 0, length);
    if (type === 0) {
      const seq = this.sequence.get(port) ?? 0;
      le16.write(b, 6, seq); this.sequence.set(port, (seq + 1) & 0xffff);
    }
    return b;
  }
  deliver(socket: UdpClient, b: Buffer) {
    const { port } = this.sockets.get(socket)!;
    this.history.set(`${port}:${ControlPacket.getSeq(b)}`, Buffer.from(b));
    queueMicrotask(() => { if (this.open.has(socket)) socket.emit('data', { address: '127.0.0.1', port }, b); });
  }
  sent(socket: UdpClient, b: Buffer, port: number) {
    this.writes.push(Buffer.from(b));
    const type = ControlPacket.getType(b);
    if (type === Cmd.ARE_YOU_THERE) {
      if (port === 50003 && this.holdAudio) return;
      this.deliver(socket, this.packet(socket, 16, Cmd.I_AM_HERE));
    } else if (type === Cmd.ARE_YOU_READY) {
      this.deliver(socket, this.packet(socket, 16, Cmd.I_AM_READY));
    } else if (type === Cmd.RETRANSMIT) {
      const seq = b.length === 16 ? ControlPacket.getSeq(b) : le16.read(b, 16);
      const old = this.history.get(`${port}:${seq}`);
      if (old) this.deliver(socket, old);
    } else if (port === 50001 && b.length === Sizes.LOGIN) {
      const response = this.packet(socket, Sizes.LOGIN_RESPONSE);
      be16.write(response, 0x1a, be16.read(b, 0x1a));
      be32.write(response, 0x1c, 123);
      if (this.rejectLogin) be32.write(response, 0x30, 1);
      if (this.dropLogin && !this.dropped) {
        this.dropped = true;
        this.history.set(`50001:${ControlPacket.getSeq(response)}`, response);
        // Subsequent traffic exposes the sequence gap; the production Session requests it.
        this.deliver(socket, this.packet(socket, 16));
      } else this.deliver(socket, response);
    } else if (port === 50001 && b.length === Sizes.TOKEN && b[0x15] === TokenType.CONFIRM) {
      const cap = this.packet(socket, Sizes.CAP_CAP); cap[0x42 + 0x52] = 0xb6; cap[0x42 + 0x57] = 1;
      this.deliver(socket, cap);
      const info = this.packet(socket, Sizes.CONNINFO); Buffer.from('IC-7300MK2').copy(info, 0x40);
      this.deliver(socket, info);
    } else if (port === 50001 && b.length === Sizes.CONNINFO) {
      const status = this.packet(socket, Sizes.STATUS);
      be16.write(status, 0x42, 50002); be16.write(status, 0x46, 50003);
      this.deliver(socket, status);
    } else if (port === 50002 && CivPacket.isCiv(b)) {
      if (this.dropCivReplies) return;
      const frame = CivPacket.getCivData(b);
      let reply: Buffer;
      if (frame[4] === 0x19) reply = Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, 0x19, 0, this.identity, 0xfd]);
      else reply = Buffer.from([0xfe, 0xfe, 0xe0, 0xb6, this.nak ? 0xfa : 0xfb, 0xfd]);
      const header = this.packet(socket, 16);
      this.deliver(socket, CivPacket.setCivData(ControlPacket.getSeq(header), 50002, ControlPacket.getRcvdId(header), 0, reply));
    }
  }
}

function rig() { return new IcomControl({ control: { ip: '127.0.0.1', port: 50001 }, userName: 'test', password: 'test' }); }
async function advance(ms = 1200) { await jest.advanceTimersByTimeAsync(ms); }

describe('Icom UDP recovery with production protocol owners', () => {
  let peer: RadioPeer;
  beforeEach(() => { jest.useFakeTimers(); peer = new RadioPeer(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

  test('MK2 completes the real handshake, resolves B6 identity and waits for write acknowledgement', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    expect(radio.profile.modelId).toBe('IC-7300MK2');
    const identity = radio.getRadioIdentity(); await advance(10);
    expect(await identity).toMatchObject({ modelId: 'IC-7300MK2', transceiverId: 0xb6, verified: true });
    const write = radio.setFrequency(14074000); await advance(10); await write;
    expect(peer.writes.some(b => CivPacket.isCiv(b) && CivPacket.getCivData(b)[2] === 0xb6)).toBe(true);
    const close = radio.disconnect(); await advance(400); await close;
    expect(peer.open.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  test('uses MK2 connector addresses in actual acknowledged CI-V frames', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    const usb = radio.setUsbAfLevel(121); await advance(10); await usb;
    const network = radio.setConnectorDataMode('WLAN'); await advance(10); await network;
    const power = radio.setPowerState('off'); await advance(10); await power;
    await expect(radio.setPowerState('invalid' as 'off')).rejects.toThrow('Unsupported ICOM power state');
    const frames = peer.writes.filter(b => CivPacket.isCiv(b)).map(b => CivPacket.getCivData(b));
    expect(frames).toContainEqual(Buffer.from([0xfe, 0xfe, 0xb6, 0xe0, 0x1a, 0x05, 0x00, 0x70, 0x01, 0x21, 0xfd]));
    expect(frames).toContainEqual(Buffer.from([0xfe, 0xfe, 0xb6, 0xe0, 0x1a, 0x05, 0x00, 0x85, 0x05, 0xfd]));
    expect(frames).toContainEqual(Buffer.from([0xfe, 0xfe, 0xb6, 0xe0, 0x18, 0x00, 0xfd]));
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('an unknown authoritative identity cannot retain a guessed MK2 profile', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    peer.identity = 0xfe;
    const identity = radio.getRadioIdentity(); await advance(10);
    expect(await identity).toMatchObject({ modelId: null, transceiverId: 0xfe, verified: false });
    expect(radio.profile.modelId).toBe('generic-modern-icom');
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('recovers a lost login response by requesting the missing tracked packet', async () => {
    peer.dropLogin = true;
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    expect(peer.writes.some(b => ControlPacket.getType(b) === Cmd.RETRANSMIT)).toBe(true);
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('rejects bad credentials promptly and closes all sockets', async () => {
    peer.rejectLogin = true;
    const radio = rig(); const failure = radio.connect().catch(e => e);
    await advance(); expect((await failure).message).toContain('login rejected');
    expect(peer.open.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  test('cancels after login and cannot be revived by late sub-session packets', async () => {
    peer.holdAudio = true;
    const radio = rig(); const result = radio.connect().catch(e => e);
    await advance(); const close = radio.disconnect(); await advance(400); await close;
    expect(await result).toBeInstanceOf(Error);
    peer.holdAudio = false;
    for (const [socket, data] of peer.sockets) {
      if (data.port === 50003) socket.emit('data', { address: '127.0.0.1', port: 50003 }, peer.packet(socket, 16, Cmd.I_AM_READY));
    }
    expect(radio.getConnectionPhase()).toBe('IDLE'); expect(peer.open.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('sub-session timeout returns the token and allows a new connection on the same object', async () => {
    peer.holdAudio = true;
    const radio = rig(); const failed = radio.connect({ timeout: 1800 }).catch(e => e);
    await advance(2200); expect((await failed).message).toContain('civ-audio-ready');
    expect(peer.open.size).toBe(0);
    expect(peer.writes.some(b => b.length === Sizes.TOKEN && b[0x15] === TokenType.DELETE)).toBe(true);
    peer.holdAudio = false; peer.sequence.clear(); peer.history.clear();
    const connected = radio.connect(); await advance(); await connected;
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('NAK rejects a critical write without reporting success or dropping the live transport', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    peer.nak = true;
    const write = radio.setPtt(true).catch(e => e); await advance(10);
    expect((await write).name).toBe('CivCommandRejectedError');
    expect(radio.audio.isPttOn).toBe(false); expect(radio.getConnectionPhase()).toBe('CONNECTED');
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('write timeout cancels queued writes before another command can reach the device', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    peer.dropCivReplies = true;
    const before = peer.writes.filter(b => CivPacket.isCiv(b)).length;
    const first = radio.setFrequency(14074000).catch(e => e);
    const second = radio.setPtt(true).catch(e => e);
    await advance(3400);
    expect((await first).message).toContain('acknowledgement timeout');
    expect((await second).message).toContain('acknowledgement timeout');
    expect(peer.writes.filter(b => CivPacket.isCiv(b)).length - before).toBe(1);
    expect(peer.open.size).toBe(0);
  });

  test('explicit disconnect cancels a pending automatic reconnect backoff', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    radio.configureMonitoring({ timeout: 100, checkInterval: 25, autoReconnect: true, reconnectBaseDelay: 1000 });
    await advance(600);
    const before = peer.writes.filter(b => b.length === Sizes.LOGIN).length;
    const close = radio.disconnect(); await advance(400); await close;
    await advance(5000);
    expect(peer.open.size).toBe(0);
    expect(peer.writes.filter(b => b.length === Sizes.LOGIN).length).toBe(before);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('concurrent disconnects share cleanup and close each socket exactly once', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    const first = radio.disconnect(), second = radio.disconnect();
    await advance(400); await Promise.all([first, second]);
    expect(UdpClient.prototype.close).toHaveBeenCalledTimes(3);
    expect(peer.open.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
  });

  test('spectrum observation shares one deadline instead of blocking for each individual read', async () => {
    const radio = rig(); const connected = radio.connect(); await advance(); await connected;
    peer.dropCivReplies = true;
    const before = peer.writes.filter(b => CivPacket.isCiv(b)).length;
    const snapshot = radio.getSpectrumDisplayState({ timeout: 30 });
    await advance(40);
    expect(await snapshot).toMatchObject({ mode: null, spanHz: null, edgeSlot: null });
    expect(peer.writes.filter(b => CivPacket.isCiv(b)).length - before).toBe(1);
    const close = radio.disconnect(); await advance(400); await close;
  });

  test('model matching is exact and the two connector tables remain independent', () => {
    expect(resolveIcomProfile({ rigName: 'IC-7300MK2', civAddress: 0xb6 }).modelId).toBe('IC-7300MK2');
    expect(resolveIcomProfile({ rigName: 'IC-7300-UNKNOWN' }).modelId).toBe('generic-modern-icom');
    expect(resolveIcomProfile({ rigName: 'IC-705' }).extParams.usbAfLevel?.subext).toEqual([1, 0x10]);
    const mk2 = resolveIcomProfile({ civAddress: 0xb6 });
    expect(mk2.vendorExtensions.connectorDataMode?.subext).toEqual([0, 0x85]);
    expect(mk2.connectorModes?.WLAN).toBe(5);
  });
});
