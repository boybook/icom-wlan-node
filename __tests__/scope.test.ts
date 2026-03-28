import { IcomControl } from '../src/rig/IcomControl';
import { DEFAULT_CONTROLLER_ADDR } from '../src/rig/IcomConstants';
import { Session } from '../src/core/Session';
import { IcomScopeCommands } from '../src/scope/IcomScopeCommands';
import { parseIcomBcdFreqLE, parseScopeSegment } from '../src/scope/IcomScopeParser';
import { IcomScopeService } from '../src/scope/IcomScopeService';

function makeScopeFrame(payload: number[]): Buffer {
  return Buffer.from([0xfe, 0xfe, 0xe0, 0xa4, ...payload, 0xfd]);
}

function encodeFreq(hz: number, byteLength: number = 5): number[] {
  const out: number[] = [];
  let remaining = hz;
  for (let i = 0; i < byteLength; i++) {
    const twoDigits = remaining % 100;
    out.push((((twoDigits / 10) | 0) << 4) | (twoDigits % 10));
    remaining = Math.floor(remaining / 100);
  }
  return out;
}

describe('scope support', () => {
  test('parseIcomBcdFreqLE decodes little-endian BCD frequency bytes', () => {
    const encoded = Buffer.from(encodeFreq(145000000));
    expect(parseIcomBcdFreqLE(encoded)).toBe(145000000);
  });

  test('parseScopeSegment parses sequence 1 header and center-mode pixels', () => {
    const frame = makeScopeFrame([
      0x27, 0x00, 0x00,
      0x01, 0x03, 0x00,
      ...encodeFreq(7100000),
      ...encodeFreq(5000),
      0x00,
      0x12, 0x34
    ]);

    const segment = parseScopeSegment(frame, 'lan-civ');
    expect(segment).not.toBeNull();
    expect(segment?.sequence).toBe(1);
    expect(segment?.sequenceMax).toBe(3);
    expect(segment?.mode).toBe(0);
    expect(segment?.startFreqHz).toBe(7095000);
    expect(segment?.endFreqHz).toBe(7105000);
    expect(Array.from(segment?.pixels ?? [])).toEqual([0x12, 0x34]);
  });

  test('IcomScopeService assembles segments into one frame and emits events', async () => {
    const service = new IcomScopeService();
    const seenSegments: number[] = [];
    const framePromise = service.waitForScopeFrame(1000);

    service.on('scopeSegment', (segment) => seenSegments.push(segment.sequence));

    const frame1 = makeScopeFrame([
      0x27, 0x00, 0x00,
      0x01, 0x03, 0x01,
      ...encodeFreq(14000000),
      ...encodeFreq(14350000),
      0x00
    ]);
    const frame2 = makeScopeFrame([0x27, 0x00, 0x00, 0x02, 0x03, 0x10, 0x11]);
    const frame3 = makeScopeFrame([0x27, 0x00, 0x00, 0x03, 0x03, 0x12, 0x13, 0x14]);

    expect(service.handleCivFrame(frame1, 'lan-civ')).toBeNull();
    expect(service.handleCivFrame(frame2, 'lan-civ')).toBeNull();
    const assembled = service.handleCivFrame(frame3, 'lan-civ');

    expect(assembled).not.toBeNull();
    expect(assembled?.startFreqHz).toBe(14000000);
    expect(assembled?.endFreqHz).toBe(14350000);
    expect(Array.from(assembled?.pixels ?? [])).toEqual([0x10, 0x11, 0x12, 0x13, 0x14]);
    expect(seenSegments).toEqual([1, 2, 3]);

    const awaited = await framePromise;
    expect(awaited?.sequenceMax).toBe(3);
  });

  test('IcomControl enableScope/disableScope send minimal command sequence', async () => {
    const openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return this;
    });

    const rig = new IcomControl({
      control: { ip: '127.0.0.1', port: 50001 },
      userName: 'user',
      password: 'pass'
    });

    rig.civ.civAddress = 0xa4;
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => { sent.push(Buffer.from(buf)); };

    await rig.enableScope();
    await rig.disableScope();

    expect(sent).toEqual([
      IcomScopeCommands.setScopeDisplay(DEFAULT_CONTROLLER_ADDR, 0xa4, true),
      IcomScopeCommands.setScopeDataOutput(DEFAULT_CONTROLLER_ADDR, 0xa4, true),
      IcomScopeCommands.setScopeDataOutput(DEFAULT_CONTROLLER_ADDR, 0xa4, false),
      IcomScopeCommands.setScopeDisplay(DEFAULT_CONTROLLER_ADDR, 0xa4, false)
    ]);

    openSpy.mockRestore();
  });

  test('IcomControl bridges civFrame into scope events', async () => {
    const openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return this;
    });

    const rig = new IcomControl({
      control: { ip: '127.0.0.1', port: 50001 },
      userName: 'user',
      password: 'pass'
    });

    const frames: number[][] = [];
    const scopeFramePromise = rig.waitForScopeFrame({ timeout: 1000 });
    rig.events.on('scopeFrame', (frame) => frames.push(Array.from(frame.pixels)));

    (rig as any).processCivPayload(Buffer.from([
      0xfe, 0xfe, 0xe0, 0xa4,
      0x27, 0x00, 0x00, 0x01, 0x02, 0x01,
      ...encodeFreq(14000000),
      ...encodeFreq(14350000),
      0x00,
      0xfd,
      0xfe, 0xfe, 0xe0, 0xa4,
      0x27, 0x00, 0x00, 0x02, 0x02, 0x21, 0x22,
      0xfd
    ]));

    const scopeFrame = await scopeFramePromise;
    expect(scopeFrame).not.toBeNull();
    expect(frames).toEqual([[0x21, 0x22]]);

    openSpy.mockRestore();
  });
});
