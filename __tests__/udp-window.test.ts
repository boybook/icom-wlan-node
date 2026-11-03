import { ReceiveWindow } from '../src/core/ReceiveWindow';
import { Session } from '../src/core/Session';
import { UdpClient } from '../src/transport/UdpClient';
import { Cmd, ControlPacket } from '../src/core/IcomPackets';
import { le16, le32 } from '../src/utils/codec';

it('orders recovered packets, requests gaps, drops duplicates and bounds waiting', () => {
  const delivered: number[] = [], requested: number[][] = [];
  const window = new ReceiveWindow(b => delivered.push(b[0]), seq => requested.push(seq));
  window.receive(0, Buffer.from([0]), 0);
  window.receive(2, Buffer.from([2]), 1);
  window.tick(25);
  expect(requested).toEqual([[1]]); expect(delivered).toEqual([0]);
  window.receive(1, Buffer.from([1]), 30);
  window.receive(1, Buffer.from([1]), 35);
  expect(delivered).toEqual([0, 1, 2]);
  window.receive(4, Buffer.from([4]), 40);
  window.tick(150);
  expect(delivered).toEqual([0, 1, 2, 4]);
});

it('handles sequence rollover and resets after a large forward discontinuity', () => {
  let delivered = 0;
  const request = jest.fn();
  const window = new ReceiveWindow(() => delivered++, request);
  for (let seq = 0; seq <= 0xffff; seq++) window.receive(seq, Buffer.from([1]), 0);
  window.receive(0, Buffer.from([1]), 1);
  expect(delivered).toBe(65537); expect(request).not.toHaveBeenCalled();
  window.receive(1000, Buffer.from([1]), 2);
  expect(delivered).toBe(65538);
  window.reset(); window.receive(0, Buffer.from([1]), 3);
  expect(delivered).toBe(65539);
});

describe('production UDP session boundary', () => {
  let session: Session;
  const sent: Buffer[] = [];
  const delivered = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers(); sent.length = 0; delivered.mockClear();
    jest.spyOn(UdpClient.prototype, 'open').mockResolvedValue();
    jest.spyOn(UdpClient.prototype, 'close').mockImplementation(() => {});
    jest.spyOn(UdpClient.prototype, 'send').mockImplementation(b => { sent.push(Buffer.from(b)); });
    session = new Session({ ip: '127.0.0.1', port: 50001 }, { onData: delivered, onSendError: e => { throw e; } });
    session.remoteId = 42; void session.open();
  });
  afterEach(() => { session.close(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });
  const receive = (s: Session, b: Buffer, address = '127.0.0.1') => s.udp.emit('data', { address, port: 50001 }, b);

  it('rejects short, wrong-length, foreign and stale-session packets before refreshing health', () => {
    session.lastReceivedTime = 123;
    const packet = ControlPacket.toBytes(Cmd.I_AM_READY, 0, 42, session.localId);
    receive(session, packet, '127.0.0.2');
    receive(session, Buffer.alloc(3));
    receive(session, ControlPacket.toBytes(Cmd.I_AM_READY, 0, 43, session.localId));
    const malformed = Buffer.from(packet); le32.write(malformed, 0, 100); receive(session, malformed);
    expect(session.lastReceivedTime).toBe(123); expect(delivered).not.toHaveBeenCalled();
    receive(session, packet); expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('responds to single and inclusive-range retransmission requests on the control stream', () => {
    session.sendTracked(ControlPacket.toBytes(0, 0, session.localId, 42));
    session.sendTracked(ControlPacket.toBytes(0, 0, session.localId, 42));
    receive(session, ControlPacket.toBytes(Cmd.RETRANSMIT, 1, 42, session.localId));
    expect(sent[2]).toEqual(sent[0]);
    const request = Buffer.alloc(20);
    ControlPacket.toBytes(Cmd.RETRANSMIT, 0, 42, session.localId).copy(request);
    le32.write(request, 0, 20); le16.write(request, 16, 1); le16.write(request, 18, 2);
    receive(session, request);
    expect(sent.slice(3)).toEqual(sent.slice(0, 2));
  });

  it('expires retransmission history rather than replaying old command payloads', async () => {
    const original = Buffer.alloc(32); ControlPacket.toBytes(0, 0, session.localId, 42).copy(original); le32.write(original, 0, 32);
    session.sendTracked(original);
    await jest.advanceTimersByTimeAsync(3100);
    receive(session, ControlPacket.toBytes(Cmd.RETRANSMIT, 1, 42, session.localId));
    expect(sent.at(-1)?.length).toBe(16);
  });
});
