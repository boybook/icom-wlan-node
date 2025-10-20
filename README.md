# @boybook/icom-wlan

Icom WLAN (UDP) protocol implementation in Node.js + TypeScript, featuring:

- Control channel handshake (AreYouThere/AreYouReady), login (0x80/0x60), token confirm/renew (0x40)
- CI‑V over UDP encapsulation (open/close keep‑alive + CIV frame transport)
- Audio stream send/receive (LPCM 16‑bit mono @ 12 kHz; 20 ms frames)
- Typed, event‑based API; designed for use as a dependency in other Node projects

This is a clean TypeScript design inspired by FT8CN’s Android implementation but written idiomatically for Node.js.

Acknowledgements: Thanks to FT8CN (https://github.com/N0BOY/FT8CN) for sharing protocol insights and inspiration.

> Note: mDNS/DNS‑SD discovery is not included; pass your radio’s IP/port directly.

## Install

```
npm install @boybook/icom-wlan
```

Build from source:

```
npm install
npm run build
```

## Quick Start

```ts
import { IcomControl, AUDIO_RATE } from '@boybook/icom-wlan';

const rig = new IcomControl({
  control: { ip: '192.168.1.50', port: 50001 },
  userName: 'user',
  password: 'pass'
});

rig.events.on('login', (res) => {
  if (res.ok) console.log('Login OK');
  else console.error('Login failed', res.errorCode);
});

rig.events.on('status', (s) => {
  console.log('Ports:', s.civPort, s.audioPort);
});

rig.events.on('capabilities', (c) => {
  console.log('CIV address:', c.civAddress, 'audio:', c.audioName);
});

rig.events.on('civ', (bytes) => {
  // raw CI‑V frame from radio (FE FE ... FD)
});

rig.events.on('audio', (frame) => {
  // frame.pcm16 is raw 16‑bit PCM mono @ 12 kHz
});

rig.events.on('error', (err) => console.error('UDP error', err));

(async () => {
  await rig.connect();
})();
```

### Send CI‑V commands

```ts
// Send an already built CI‑V frame
rig.sendCiv(Buffer.from([0xfe,0xfe,0xa4,0xe0,0x03,0xfd]));
```

### PTT and Audio TX

```ts
// Start PTT and begin audio transmit (queue frames at 20 ms cadence)
rig.setPtt(true);

// Provide Float32 samples in [-1,1]
const tone = new Float32Array(240); // 20 ms @ 12k
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2*Math.PI*1000 * i / AUDIO_RATE);
rig.sendAudioFloat32(tone);

// Stop PTT
rig.setPtt(false);
```

## API Overview

- `new IcomControl(options)`
  - `options.control`: `{ ip, port }` radio control UDP endpoint
  - `options.userName`, `options.password`
- Events (`rig.events.on(...)`)
  - `login(LoginResult)` — 0x60 processed (ok/error)
  - `status(StatusInfo)` — civ/audio ports from 0x50
  - `capabilities(CapabilitiesInfo)` — civ address, audio name (0xA8)
  - `civ(Buffer)` — CI‑V payload from radio
  - `audio({ pcm16: Buffer })` — audio frames
  - `error(Error)` — UDP errors
- Methods
  - `connect()` / `disconnect()`
  - `sendCiv(buf: Buffer)`
  - `setPtt(on: boolean, ctrAddr=0xe0, rigAddr=0xa4)`
  - `sendAudioFloat32(samples: Float32Array)` / `sendAudioPcm16(samples: Int16Array)`

### High‑Level API

The library exposes common CI‑V operations as friendly methods. All addresses default to `ctrAddr=0xe0` and `rigAddr` from radio capabilities (`civAddress`).

- `setFrequency(hz, ctrAddr?, rigAddr?)`
- `setMode(mode, { dataMode?: boolean, ctrAddr?, rigAddr? })`
- `setPtt(on, ctrAddr?, rigAddr?)`
- `readOperatingFrequency(timeoutMs?, ctrAddr?, rigAddr?) => Promise<number|null>`
- `readSWR(timeoutMs?, ctrAddr?, rigAddr?) => Promise<Buffer|null>`
- `readALC(timeoutMs?, ctrAddr?, rigAddr?) => Promise<Buffer|null>`
- `getConnectorWLanLevel(timeoutMs?, ctrAddr?, rigAddr?) => Promise<Buffer|null>`
- `setConnectorWLanLevel(level, ctrAddr?, rigAddr?)`
- `setConnectorDataMode(mode, ctrAddr?, rigAddr?)`

Examples:

```ts
// Set frequency and mode (USB-D)
await rig.setFrequency(14074000);
await rig.setMode(0x01, { dataMode: true }); // USB=0x01, data mode

// Query current frequency (Hz)
const hz = await rig.readOperatingFrequency();
console.log('Rig freq:', hz);

// Toggle PTT and send a short 1 kHz tone
rig.setPtt(true);
for (let n = 0; n < 10; n++) {
  const tone = new Float32Array(240);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2*Math.PI*1000*i/AUDIO_RATE) * 0.2;
  rig.sendAudioFloat32(tone);
  await new Promise(r => setTimeout(r, 20));
}
rig.setPtt(false);

// Read meters and connector settings
const swr = await rig.readSWR();
const alc = await rig.readALC();
const wlanLevel = await rig.getConnectorWLanLevel();
await rig.setConnectorWLanLevel(0x0120);
await rig.setConnectorDataMode(0x01); // e.g., DATA
```

## Design Notes

- Packets follow Icom’s UDP framing: fixed headers with mixed endianness. See `src/core/IcomPackets.ts` for builders/parsers.
- Separate UDP session with tracked sequence numbers and resend history (skeleton) in `src/core/Session.ts`.
- CI‑V and Audio sub‑channels reuse the same UDP transport here; radios expose distinct ports after 0x50. You can adapt by creating additional `Session` instances bound to those ports if desired.
- Credentials use the same simple substitution cipher as FT8CN’s Android client (`passCode`).
- The 0x90/0x50 handshake strictly follows FT8CN’s timing and endianness. We pre‑open local CIV/Audio sockets, reply with local ports on first 0x90, then set remote ports upon 0x50.
- CIV/audio sub‑sessions each run their own Ping/Idle and (for CIV) OpenClose keep‑alive.

## Tests

- Unit tests cover packet builders/parsers and minimal session sequencing.
- Run: `npm test` (requires dev dependencies installed).
- Integration test against a real radio is included. Set env vars: `ICOM_IP`, `ICOM_PORT` (control), `ICOM_USER`, `ICOM_PASS`. Optional: `ICOM_TEST_PTT=true`.

Example:

```
ICOM_IP=192.168.31.253 ICOM_PORT=50001 ICOM_USER=icom ICOM_PASS=icomicom npm test -- __tests__/integration.real.test.ts
```

## Limitations / TODO

- Discovery (mDNS) not implemented.
- Full token renewal loop and advanced status flag parsing simplified.
- Audio receive/playback is library‑only; playback is up to the integrator.
- Robust retransmit/multi‑retransmit handling can be extended.

## License

MIT
