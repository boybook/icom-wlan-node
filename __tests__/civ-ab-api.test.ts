import { Session } from '../src/core/Session';
import { IcomControl } from '../src/rig/IcomControl';
import { DEFAULT_CONTROLLER_ADDR, MODE_MAP } from '../src/rig/IcomConstants';
import { encodeBcdBE, encodeFrequencyBcdLE } from '../src/rig/IcomCivFrame';

function makeRig(model: 'IC-705' | 'IC-9700' | 'IC-7610' | 'IC-7760' | 'generic-modern-icom' = 'IC-705') {
  const rig = new IcomControl({
    control: { ip: '127.0.0.1', port: 50001 },
    userName: 'user',
    password: 'pass',
    model,
  });
  rig.civ.civAddress = model === 'IC-9700' ? 0xa2 : model === 'IC-7610' ? 0x98 : model === 'IC-7760' ? 0xb2 : 0xa4;
  return rig;
}

describe('Hamlib A/B CI-V API expansion', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return Promise.resolve();
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('function commands use Hamlib 0x16 subcommands and BKIN special values', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig.civ.civAddress, 0xfb, 0xfd]))); sent.push(Buffer.from(buf)); };

    await rig.setFunction('NR', true);
    await rig.setFunction('NB', true);
    await rig.setBreakInMode('semi');
    await rig.setBreakInMode('full');
    await rig.setDialLockEnabled(true);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x40, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x22, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x47, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x47, 0x02, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x50, 0x01, 0xfd]),
    ]);
  });

  test('generic level API encodes Hamlib 0x14 levels and special CWPITCH/KEYSPD mappings', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig.civ.civAddress, 0xfb, 0xfd]))); sent.push(Buffer.from(buf)); };

    await rig.setRFGain(0.5);
    await rig.setPbtIn(0.25);
    await rig.setPbtOut(0.75);
    await rig.setCwPitch(900);
    await rig.setKeySpeed(48);
    await rig.setMonitorGain(1);
    await rig.setVoxGain(0);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x02, 0x01, 0x28, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x07, 0x00, 0x64, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x08, 0x01, 0x91, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x09, 0x02, 0x55, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x0c, 0x02, 0x50, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x15, 0x02, 0x55, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x16, 0x00, 0x00, 0xfd]),
    ]);
  });

  test('generic getFunction and getLevel queries parse keyed replies', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig.civ.civAddress, 0xfb, 0xfd])));
      sent.push(Buffer.from(buf));
      if (buf[4] === 0x16 && buf[5] === 0x40) {
        setTimeout(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x16, 0x40, 0x01, 0xfd])), 0);
      } else if (buf[4] === 0x14 && buf[5] === 0x02) {
        setTimeout(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x14, 0x02, 0x01, 0x28, 0xfd])), 0);
      }
    };

    await expect(rig.getFunction('NR', { timeout: 1000 })).resolves.toBe(true);
    await expect(rig.getLevel('RF', { timeout: 1000 })).resolves.toBeCloseTo(128 / 255, 4);
    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x40, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x02, 0xfd]),
    ]);
  });

  test('RIT/XIT, split frequency/mode, repeater offset, and CTCSS tone commands match Hamlib', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig.civ.civAddress, 0xfb, 0xfd]))); sent.push(Buffer.from(buf)); };

    await rig.setRitOffset(-1234);
    await rig.setRitEnabled(true);
    await rig.setXitEnabled(false);
    await rig.setSplitFrequency(14_074_000);
    await rig.setSplitMode('USB', { dataMode: true, filter: 2 });
    await rig.setRepeaterOffset(600_000);
    await rig.setToneFrequency(88.5);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x21, 0x00, 0x34, 0x12, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x21, 0x01, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x21, 0x02, 0x00, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x25, 0x01, ...encodeFrequencyBcdLE(14_074_000, 5), 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x26, 0x01, MODE_MAP.USB, 0x01, 0x02, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x0d, ...encodeFrequencyBcdLE(6000, 3), 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1b, 0x00, ...encodeBcdBE(885, 3), 0xfd]),
    ]);
  });

  test('profile ext params support AFIF routing and USB AF profile differences', async () => {
    const rig705 = makeRig('IC-705');
    const sent705: Buffer[] = [];
    (rig705 as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig705.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig705.civ.civAddress, 0xfb, 0xfd]))); sent705.push(Buffer.from(buf)); };
    await rig705.setAudioIfMode('wlan');
    await rig705.setUsbAfLevel(121);

    expect(sent705).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x14, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x09, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x10, 0x01, 0x21, 0xfd]),
    ]);

    const rig9700 = makeRig('IC-9700');
    const sent9700: Buffer[] = [];
    (rig9700 as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig9700.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig9700.civ.civAddress, 0xfb, 0xfd]))); sent9700.push(Buffer.from(buf)); };
    await rig9700.setAudioIfMode('lan');
    expect(sent9700).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x10, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x00, 0x00, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x05, 0x01, 0xfd]),
    ]);

    const rig7760 = makeRig('IC-7760');
    await expect(rig7760.setUsbAfLevel(10)).rejects.toThrow('Unsupported ICOM CI-V command');
  });

  test('spectrum advanced commands encode speed, ref, VBW/RBW, TX, center type, and avg', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      queueMicrotask(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, 0xe0, rig.civ.civAddress, 0xfb, 0xfd]))); sent.push(Buffer.from(buf)); };

    await rig.setSpectrumHold(true, { receiver: 0 });
    await rig.setSpectrumSpeed('slow', { receiver: 0 });
    await rig.setSpectrumRef(-12.4, { receiver: 0 });
    await rig.setSpectrumVbw(1, { receiver: 0 });
    await rig.setSpectrumDuringTx(true);
    await rig.setSpectrumCenterType('carrier-point-center-abs');
    await rig.setSpectrumAverage(3);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x17, 0x00, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x1a, 0x00, 0x02, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x19, 0x00, 0x12, 0x50, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x1d, 0x00, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x1b, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x27, 0x1c, 0x02, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x78, 0x03, 0xfd]),
    ]);
  });
});
