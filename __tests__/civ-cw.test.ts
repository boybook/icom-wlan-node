import { Session } from '../src/core/Session';
import { DEFAULT_CONTROLLER_ADDR, MODE_MAP } from '../src/rig/IcomConstants';
import { CIV } from '../src/rig/IcomCivSpec';
import { IcomControl } from '../src/rig/IcomControl';
import { IcomRigCommands } from '../src/rig/IcomRigCommands';
import { ICOM_PROFILES } from '../src/rig/IcomProfiles';

function makeRig(model: 'IC-705' | 'generic-modern-icom' = 'IC-705') {
  const rig = new IcomControl({
    control: { ip: '127.0.0.1', port: 50001 },
    userName: 'user',
    password: 'pass',
    model,
  });
  rig.civ.civAddress = 0xa4;
  return rig;
}

const ack = Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.ACK, 0xfd]);
const nak = Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, CIV.NAK, 0xfd]);
const modeReply = (mode: number) => Buffer.from([0xfe, 0xfe, DEFAULT_CONTROLLER_ADDR, 0xa4, 0x26, 0x00, mode, 0x00, 0x01, 0xfd]);

describe('Hamlib-aligned ICOM CW text sending', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(Session.prototype, 'open').mockImplementation(function mockOpen(this: Session) {
      return this;
    });
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  test('builders encode CI-V 0x17 send and stop frames', () => {
    expect(IcomRigCommands.sendMorseText(DEFAULT_CONTROLLER_ADDR, 0xa4, 'CQ')).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, 0x43, 0x51, 0xfd])
    );
    expect(IcomRigCommands.stopMorse(DEFAULT_CONTROLLER_ADDR, 0xa4)).toEqual(
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, 0xff, 0xfd])
    );
  });

  test('profiles gate CW text support separately from generic function list', async () => {
    for (const model of ['IC-705', 'IC-905', 'IC-7300', 'IC-9700', 'IC-7610', 'IC-7760'] as const) {
      expect(ICOM_PROFILES[model].cw).toEqual({ sendMorse: true, maxChunkLength: 30 });
    }
    expect(ICOM_PROFILES['generic-modern-icom'].cw).toEqual({ sendMorse: false, maxChunkLength: 30 });

    const generic = makeRig('generic-modern-icom');
    await expect(generic.sendMorse('CQ', { checkMode: false, timeout: 100 })).rejects.toThrow('Unsupported ICOM CI-V command');
  });

  test('sendMorse checks CW mode, normalizes text, sends chunk, and waits for ACK', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      if (buf[4] === CIV.C_SEND_SEL_MODE) {
        setTimeout(() => rig.events.emit('civFrame', modeReply(MODE_MAP.CW)), 0);
      } else if (buf[4] === CIV.C_SND_CW) {
        setTimeout(() => rig.events.emit('civFrame', ack), 0);
      }
    };

    await rig.sendMorse('cq', { timeout: 1000 });

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x26, 0x00, 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, 0x43, 0x51, 0xfd]),
    ]);
  });

  test('sendMorse rejects non-CW mode unless checkMode is disabled', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      setTimeout(() => rig.events.emit('civFrame', modeReply(MODE_MAP.USB)), 0);
    };

    await expect(rig.sendMorse('CQ', { timeout: 1000 })).rejects.toThrow('requires CW/CW_R mode');
    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x26, 0x00, 0xfd]),
    ]);
  });

  test('sendMorse checkMode false chunks long text and sends chunks sequentially', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      setTimeout(() => rig.events.emit('civFrame', ack), 0);
    };

    await rig.sendMorse('abcdefghijklmnopqrstuvwxyz12345', { checkMode: false, timeout: 1000 });

    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, ...Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234', 'ascii'), 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, 0x35, 0xfd]),
    ]);
  });

  test('sendMorse rejects NAK replies with chunk context', async () => {
    const rig = makeRig();
    (rig as any).sendCiv = (buf: Buffer) => {
      if (buf[4] === CIV.C_SEND_SEL_MODE) {
        setTimeout(() => rig.events.emit('civFrame', modeReply(MODE_MAP.CW_R)), 0);
      } else if (buf[4] === CIV.C_SND_CW) {
        setTimeout(() => rig.events.emit('civFrame', nak), 0);
      }
    };

    await expect(rig.sendMorse('CQ', { timeout: 1000 })).rejects.toThrow('CW 0x17 chunk 1 NAK received');
  });

  test('stopMorse sends 0xff and prevents queued chunks from continuing', async () => {
    const rig = makeRig();
    const sent: Buffer[] = [];
    const ackFns: Array<() => void> = [];
    (rig as any).sendCiv = (buf: Buffer) => {
      sent.push(Buffer.from(buf));
      if (buf[4] === CIV.C_SND_CW) {
        ackFns.push(() => rig.events.emit('civFrame', ack));
      }
    };

    const sendPromise = rig.sendMorse('A'.repeat(31), { checkMode: false, timeout: 1000 });
    await waitUntil(() => sent.length === 1);
    const stopPromise = rig.stopMorse({ timeout: 1000 });
    ackFns.shift()?.();
    await waitUntil(() => sent.length === 2);
    ackFns.shift()?.();

    await expect(Promise.all([sendPromise, stopPromise])).resolves.toEqual([undefined, undefined]);
    expect(sent).toEqual([
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, ...Buffer.from('A'.repeat(30), 'ascii'), 0xfd]),
      Buffer.from([0xfe, 0xfe, 0xa4, DEFAULT_CONTROLLER_ADDR, 0x17, 0xff, 0xfd]),
    ]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitUntil timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
