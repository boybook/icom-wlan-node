import { Session } from '../src/core/Session';
import { DEFAULT_CONTROLLER_ADDR, MODE_MAP } from '../src/rig/IcomConstants';
import { encodeFrequencyBcdLE } from '../src/rig/IcomCivFrame';
import { IcomControl } from '../src/rig/IcomControl';

function makeRig() {
  const rig = new IcomControl({
    control: { ip: '127.0.0.1', port: 50001 },
    userName: 'user',
    password: 'pass',
    model: 'IC-705',
  });
  rig.civ.civAddress = 0xa4;
  return rig;
}

function meterReply(subcmd: number, hi: number, lo: number): Buffer {
  return Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x15, subcmd, hi, lo, 0xfd]);
}

function scopeFixedEdgeReply(rangeId: number, edgeSlot: number, lowHz: number, highHz: number): Buffer {
  return Buffer.from([
    0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4,
    0x27, 0x1e, rangeId, edgeSlot,
    ...encodeFrequencyBcdLE(lowHz, 5),
    ...encodeFrequencyBcdLE(highHz, 5),
    0xfd,
  ]);
}

describe('CI-V query concurrency', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return this;
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('deduplicates identical readOperatingFrequency requests', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      setTimeout(() => {
        rig.events.emit('civFrame', Buffer.from([
          0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4,
          0x25, 0x00,
          ...encodeFrequencyBcdLE(14_074_000, 5),
          0xfd,
        ]));
      }, 0);
    };

    await expect(Promise.all([
      rig.readOperatingFrequency({ timeout: 1000 }),
      rig.readOperatingFrequency({ timeout: 1000 }),
    ])).resolves.toEqual([14_074_000, 14_074_000]);
    expect(sent).toHaveLength(1);
  });

  test('allows different response keys to run concurrently', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      if (buf[4] === 0x25) {
        setTimeout(() => {
          rig.events.emit('civFrame', Buffer.from([
            0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4,
            0x25, 0x00,
            ...encodeFrequencyBcdLE(7_074_000, 5),
            0xfd,
          ]));
        }, 5);
      } else if (buf[4] === 0x26) {
        setTimeout(() => {
          rig.events.emit('civFrame', Buffer.from([
            0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4,
            0x26, 0x00, MODE_MAP.USB, 0x01, 0x02, 0xfd,
          ]));
        }, 0);
      }
    };

    const [freq, mode] = await Promise.all([
      rig.readOperatingFrequency({ timeout: 1000 }),
      rig.readOperatingMode({ timeout: 1000 }),
    ]);

    expect(freq).toBe(7_074_000);
    expect(mode).toMatchObject({ mode: MODE_MAP.USB, dataMode: true, filter: 2 });
    expect(sent).toHaveLength(2);
  });

  test('distinguishes concurrent meter requests by subcommand', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      if (buf[5] === 0x12) {
        setTimeout(() => rig.events.emit('civFrame', meterReply(0x12, 0x00, 0x48)), 5);
      } else if (buf[5] === 0x13) {
        setTimeout(() => rig.events.emit('civFrame', meterReply(0x13, 0x01, 0x20)), 0);
      }
    };

    const [swr, alc] = await Promise.all([
      rig.readSWR({ timeout: 1000 }),
      rig.readALC({ timeout: 1000 }),
    ]);

    expect(swr).toMatchObject({ raw: 48, swr: 1.5 });
    expect(alc).toMatchObject({ raw: 120, percent: 100 });
    expect(sent).toHaveLength(2);
  });

  test('distinguishes concurrent scope fixed-edge requests by range and slot', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      const rangeId = buf[6];
      const edgeSlot = buf[7];
      setTimeout(() => {
        rig.events.emit('civFrame', scopeFixedEdgeReply(rangeId, edgeSlot, rangeId * 1_000_000, rangeId * 1_000_000 + 10_000));
      }, rangeId === 7 ? 5 : 0);
    };

    const [edge7, edge8] = await Promise.all([
      rig.readScopeFixedEdge(7, 1, { timeout: 1000 }),
      rig.readScopeFixedEdge(8, 1, { timeout: 1000 }),
    ]);

    expect(edge7).toMatchObject({ rangeId: 7, edgeSlot: 1, lowHz: 7_000_000, highHz: 7_010_000 });
    expect(edge8).toMatchObject({ rangeId: 8, edgeSlot: 1, lowHz: 8_000_000, highHz: 8_010_000 });
    expect(sent).toHaveLength(2);
  });

  test('cleans up timed-out same-key requests before later retries', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    let shouldReply = false;
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      if (shouldReply) {
        setTimeout(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x1c, 0x00, 0x01, 0xfd])), 0);
      }
    };

    await expect(rig.readPtt({ timeout: 20 })).resolves.toBeNull();
    shouldReply = true;
    await expect(rig.readPtt({ timeout: 1000 })).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('ignores unsolicited non-matching frames while a request is pending', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      setTimeout(() => {
        rig.events.emit('civFrame', meterReply(0x12, 0x00, 0x48));
        rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x1c, 0x00, 0x00, 0xfd]));
      }, 0);
    };

    await expect(rig.readPtt({ timeout: 1000 })).resolves.toBe(false);
    expect(sent).toHaveLength(1);
  });
});
