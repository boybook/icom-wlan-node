import { Session } from '../src/core/Session';
import { ControlPacket, Cmd } from '../src/core/IcomPackets';

// This test validates basic tracked/untracked sequence behaviors using a fake remote address.

describe('Session basics', () => {
  test('open/close and tracked sequence increments', () => {
    const s = new Session({ ip: '127.0.0.1', port: 65000 }, { onData: () => {}, onSendError: () => {} });
    s.open();
    const startSeq = s.trackedSeq;
    s.sendTracked(ControlPacket.toBytes(Cmd.NULL, 0, s.localId, 0));
    expect(s.trackedSeq).toBe((startSeq + 1) & 0xffff);
    s.close();
  });
});

