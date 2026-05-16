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
      return this;
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('function commands use Hamlib 0x16 subcommands and BKIN special values', () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    rig.setFunction('NR', true);
    rig.setFunction('NB', true);
    rig.setBreakInMode('semi');
    rig.setBreakInMode('full');
    rig.setDialLockEnabled(true);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x40, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x22, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x47, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x47, 0x02, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x16, 0x50, 0x01, 0xfd]),
    ]);
  });

  test('generic level API encodes Hamlib 0x14 levels and special CWPITCH/KEYSPD mappings', () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    rig.setRFGain(0.5);
    rig.setPbtIn(0.25);
    rig.setPbtOut(0.75);
    rig.setCwPitch(900);
    rig.setKeySpeed(48);
    rig.setMonitorGain(1);
    rig.setVoxGain(0);

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

  test('RIT/XIT, split frequency/mode, repeater offset, and CTCSS tone commands match Hamlib', () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    rig.setRitOffset(-1234);
    rig.setRitEnabled(true);
    rig.setXitEnabled(false);
    rig.setSplitFrequency(14_074_000);
    rig.setSplitMode('USB', { dataMode: true, filter: 2 });
    rig.setRepeaterOffset(600_000);
    rig.setToneFrequency(88.5);

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
    (rig705 as any).sendCiv = (buf: Buffer) => sent705.push(Buffer.from(buf));
    rig705.setAudioIfMode('wlan');
    await rig705.setUsbAfLevel(121);

    expect(sent705).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x14, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x09, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x13, 0x01, 0x21, 0xfd]),
    ]);

    const rig9700 = makeRig('IC-9700');
    const sent9700: Buffer[] = [];
    (rig9700 as any).sendCiv = (buf: Buffer) => sent9700.push(Buffer.from(buf));
    rig9700.setAudioIfMode('lan');
    expect(sent9700).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x10, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x00, 0x00, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa2, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x05, 0x01, 0xfd]),
    ]);

    const rig7760 = makeRig('IC-7760');
    await expect(rig7760.setUsbAfLevel(10)).rejects.toThrow('Unsupported ICOM CI-V command');
  });

  test('spectrum advanced commands encode speed, ref, VBW/RBW, TX, center type, and avg', () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    rig.setSpectrumHold(true, { receiver: 0 });
    rig.setSpectrumSpeed('slow', { receiver: 0 });
    rig.setSpectrumRef(-12.4, { receiver: 0 });
    rig.setSpectrumVbw(1, { receiver: 0 });
    rig.setSpectrumDuringTx(true);
    rig.setSpectrumCenterType('carrier-point-center-abs');
    rig.setSpectrumAverage(3);

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
