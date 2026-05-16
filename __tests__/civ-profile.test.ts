import { IcomControl } from '../src/rig/IcomControl';
import { IcomRigCommands } from '../src/rig/IcomRigCommands';
import { DEFAULT_CONTROLLER_ADDR, MODE_MAP } from '../src/rig/IcomConstants';
import { CIV } from '../src/rig/IcomCivSpec';
import { buildCivFrame, encodeFrequencyBcdLE } from '../src/rig/IcomCivFrame';
import { Session } from '../src/core/Session';

function makeRig(model: 'IC-705' | 'IC-905' | 'IC-7300' | 'generic-modern-icom' = 'IC-705') {
  const rig = new IcomControl({
    control: { ip: '127.0.0.1', port: 50001 },
    userName: 'user',
    password: 'pass',
    model,
  });
  rig.civ.civAddress = model === 'IC-905' ? 0xac : model === 'IC-7300' ? 0x94 : 0xa4;
  return rig;
}

function reply(rigAddr: number, cmd: number, subcmd: number, bcdHi: number, bcdLo: number): Buffer {
  return Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, rigAddr, cmd, subcmd, bcdHi, bcdLo, 0xfd]);
}

describe('Hamlib-aligned CI-V profile behavior', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return this;
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('buildCivFrame creates standard FE FE rig ctrl command frames', () => {
    expect(buildCivFrame({ rigAddr: 0xa4, ctrlAddr: 0xe0, cmd: 0x1c, subcmd: 0x00, payload: [0x01] })).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, 0xe0, 0x1c, 0x00, 0x01, 0xfd])
    );
  });

  test('0x14 level subcommands match Hamlib definitions', () => {
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_MICGAIN)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x0b, 0xfd])
    );
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_NR)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x06, 0xfd])
    );
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_BKINDL)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x0f, 0xfd])
    );
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_DIGI)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x13, 0xfd])
    );
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_NB)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x12, 0xfd])
    );
    expect(IcomRigCommands.get0x14Level(DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.S_LVL_RFPOWER)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x14, 0x0a, 0xfd])
    );
  });

  test('modern profiles use 0x26 selected-mode command with data mode and filter', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    await rig.setMode('USB');
    await rig.setMode('USB', { dataMode: true, filter: 2 });

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x26, 0x00, MODE_MAP.USB, 0x00, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x26, 0x00, MODE_MAP.USB, 0x01, 0x02, 0xfd]),
    ]);
  });

  test('legacy fallback uses 0x06 set-mode when profile disables 0x26', async () => {
    const rig = makeRig('generic-modern-icom');
    (rig as any).activeProfile = { ...(rig as any).activeProfile, supportsX25X26: false, modeWithFilter: false };
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    await rig.setMode('USB', { filter: 3 });

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x06, MODE_MAP.USB, 0x03, 0xfd]),
    ]);
  });

  test('modern profiles use 0x25 selected-frequency and IC-905 uses 6-byte BCD above 5.85GHz', async () => {
    const rig = makeRig('IC-905');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    await rig.setFrequency(10_368_000_000);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xac, DEFAULT_CONTROLLER_ADDR, 0x25, 0x00, ...encodeFrequencyBcdLE(10_368_000_000, 6), 0xfd]),
    ]);
  });

  test('readOperatingFrequency parses 0x25 replies from fixed payload offset', async () => {
    const rig = makeRig('IC-705');
    (rig as any).sendCiv = () => {
      setTimeout(() => {
        rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x25, 0x00, ...encodeFrequencyBcdLE(14_074_000, 5), 0xfd]));
      }, 0);
    };

    await expect(rig.readOperatingFrequency({ timeout: 1000 })).resolves.toBe(14_074_000);
  });

  test('tuner commands use standard 0x1c/0x01 family', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    await rig.setTunerEnabled(true);
    await rig.startManualTune();

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1c, 0x01, 0x01, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1c, 0x01, 0x02, 0xfd]),
    ]);
  });

  test('profile-gated connector extensions use configured subext or reject unsupported models', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => sent.push(Buffer.from(buf));

    await rig.setConnectorWLanLevel(120);
    await rig.setConnectorDataMode('WLAN');
    await rig.setUsbAfLevel(121);

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x17, 0x01, 0x20, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x19, 0x03, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1a, 0x05, 0x01, 0x13, 0x01, 0x21, 0xfd]),
    ]);

    const generic = makeRig('generic-modern-icom');
    await expect(generic.setConnectorWLanLevel(120)).rejects.toThrow('Unsupported ICOM CI-V command');
  });

  test('readPtt powers readTransceiverState through 0x1c/0x00', async () => {
    const rig = makeRig('IC-705');
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      setTimeout(() => rig.events.emit('civFrame', Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x1c, 0x00, 0x01, 0xfd])), 0);
    };

    await expect(rig.readTransceiverState({ timeout: 1000 })).resolves.toBe('TX');
    expect(sent[0]).toEqual(Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x1c, 0x00, 0xfd]));
  });

  test('meter calibrations are profile-aware', async () => {
    const rig705 = makeRig('IC-705');
    (rig705 as any).sendCiv = () => setTimeout(() => rig705.events.emit('civFrame', reply(0xa4, 0x15, 0x11, 0x02, 0x13)), 0);
    const power705 = await rig705.readPowerLevel({ timeout: 1000 });
    expect(power705?.raw).toBe(213);
    expect(power705?.watts).toBeCloseTo(10, 1);

    const rig7300 = makeRig('IC-7300');
    (rig7300 as any).sendCiv = () => setTimeout(() => rig7300.events.emit('civFrame', reply(0x94, 0x15, 0x11, 0x02, 0x13)), 0);
    const power7300 = await rig7300.readPowerLevel({ timeout: 1000 });
    expect(power7300?.watts).toBeCloseTo(100, 1);

    const rigSwr = makeRig('IC-705');
    (rigSwr as any).sendCiv = () => setTimeout(() => rigSwr.events.emit('civFrame', reply(0xa4, 0x15, 0x12, 0x00, 0x48)), 0);
    await expect(rigSwr.readSWR({ timeout: 1000 })).resolves.toMatchObject({ raw: 48, swr: 1.5 });

    const rigAlc = makeRig('IC-705');
    (rigAlc as any).sendCiv = () => setTimeout(() => rigAlc.events.emit('civFrame', reply(0xa4, 0x15, 0x13, 0x01, 0x20)), 0);
    await expect(rigAlc.readALC({ timeout: 1000 })).resolves.toMatchObject({ raw: 120, percent: 100 });

    const rigCurrent = makeRig('IC-705');
    (rigCurrent as any).sendCiv = () => setTimeout(() => rigCurrent.events.emit('civFrame', reply(0xa4, 0x15, 0x16, 0x02, 0x41)), 0);
    await expect(rigCurrent.readCurrent({ timeout: 1000 })).resolves.toMatchObject({ raw: 241, amps: 4 });
  });
});
