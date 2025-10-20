import { ControlPacket, Cmd, PingPacket, LoginPacket, AudioPacket, Sizes, ConnInfoPacket } from '../src/core/IcomPackets';

describe('IcomPackets', () => {
  test('control packet build/parse', () => {
    const p = ControlPacket.toBytes(Cmd.ARE_YOU_THERE, 0, 0x11111111, 0x22222222);
    expect(p.length).toBe(Sizes.CONTROL);
    expect(ControlPacket.getType(p)).toBe(Cmd.ARE_YOU_THERE);
    expect(ControlPacket.getSentId(p)).toBe(0x11111111);
    expect(ControlPacket.getRcvdId(p)).toBe(0x22222222);
  });

  test('ping request/reply', () => {
    const req = PingPacket.buildPing(1, 2, 3);
    const rep = PingPacket.buildReply(req, 9, 8);
    expect(req.length).toBe(Sizes.PING);
    expect(rep.length).toBe(Sizes.PING);
    expect(rep[0x10]).toBe(0x01);
  });

  test('login packet contains encoded credentials', () => {
    const lp = LoginPacket.build(0, 1, 2, 0x30, 0x1234, 0xabcdef01, 'user', 'pass', 'name');
    expect(lp.length).toBe(Sizes.LOGIN);
    // basic sanity: username/password/name blocks non-zero
    expect(lp.subarray(0x40, 0x40 + 16).some(b => b !== 0)).toBe(true);
    expect(lp.subarray(0x50, 0x50 + 16).some(b => b !== 0)).toBe(true);
    expect(lp.subarray(0x60, 0x60 + 16).some(b => b !== 0)).toBe(true);
  });

  test('audio packet', () => {
    const audio = Buffer.alloc(480, 0);
    const ap = AudioPacket.getTxAudioPacket(audio, 0, 1, 2, 3);
    expect(ap.length).toBe(0x18 + 480);
    expect(AudioPacket.isAudioPacket(ap)).toBe(true);
    expect(AudioPacket.getAudioData(ap).length).toBe(480);
  });

  test('conninfo packet build', () => {
    const mac = Buffer.from([1,2,3,4,5,6]);
    const p = ConnInfoPacket.connectRequestPacket(0, 1, 2, 0x01, 0x03, 0x30, 0x1234, 0xabcdef01,
      mac, 'Rigname', 'user', 12000, 40000, 40001, 0x96);
    expect(p.length).toBe(Sizes.CONNINFO);
    expect(p.readUInt32BE(0x74)).toBe(12000);
    expect(p.readUInt32BE(0x7c)).toBe(40000);
    expect(p.readUInt32BE(0x80)).toBe(40001);
  });
});
