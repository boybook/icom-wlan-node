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

// Also available: parsed per‑frame CI‑V event (already segmented FE FE ... FD)
rig.events.on('civFrame', (frame) => {
  // One complete CI‑V frame
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
await rig.setPtt(true);

// Provide Float32 samples in [-1,1]
const tone = new Float32Array(240); // 20 ms @ 12k
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2*Math.PI*1000 * i / AUDIO_RATE);
// Optional 2nd arg `addLeadingBuffer=true` inserts a short leading silence
rig.sendAudioFloat32(tone, true);

// Stop PTT
await rig.setPtt(false);
```

## API Overview

- `new IcomControl(options)`
  - `options.control`: `{ ip, port }` radio control UDP endpoint
  - `options.userName`, `options.password`
- Events (`rig.events.on(...)`)
  - `login(LoginResult)` — 0x60 processed (ok/error)
  - `status(StatusInfo)` — CI‑V/audio ports from 0x50
  - `capabilities(CapabilitiesInfo)` — civ address, audio name (0xA8)
  - `civ(Buffer)` — raw CI‑V payload bytes as transported over UDP
  - `civFrame(Buffer)` — one complete CI‑V frame (FE FE ... FD)
  - `audio({ pcm16: Buffer })` — audio frames
  - `error(Error)` — UDP errors
- Methods
  - `connect()` / `disconnect()` — connects control + CIV + audio sub‑sessions; resolves when all ready
  - `sendCiv(buf: Buffer)` — send a raw CI‑V frame
  - `setPtt(on: boolean)` — key/unkey; also manages TX meter polling and audio tailing
  - `sendAudioFloat32(samples: Float32Array, addLeadingBuffer?: boolean)` / `sendAudioPcm16(samples: Int16Array)`

### High‑Level API

The library exposes common CI‑V operations as friendly methods. Addresses are handled internally (`ctrAddr=0xe0`, `rigAddr` discovered via capabilities).

- `setFrequency(hz: number)`
- `setMode(mode: IcomMode | number, { dataMode?: boolean })`
- `setPtt(on: boolean)`
- `readOperatingFrequency(options?: QueryOptions) => Promise<number|null>`
- `readOperatingMode(options?: QueryOptions) => Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string } | null>`
- `readTransmitFrequency(options?: QueryOptions) => Promise<number|null>`
- `readTransceiverState(options?: QueryOptions) => Promise<'TX' | 'RX' | 'UNKNOWN' | null>`
- `readBandEdges(options?: QueryOptions) => Promise<Buffer|null>`
- `readSWR(options?: QueryOptions) => Promise<{ raw: number; swr: number; alert: boolean } | null>`
- `readALC(options?: QueryOptions) => Promise<{ raw: number; percent: number; alert: boolean } | null>`
- `getConnectorWLanLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>`
- `getLevelMeter(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>`
- `setConnectorWLanLevel(level: number)`
- `setConnectorDataMode(mode: ConnectorDataMode | number)`

Examples:

```ts
// Set frequency and mode (USB-D)
await rig.setFrequency(14074000);
await rig.setMode(0x01, { dataMode: true }); // USB=0x01, data mode

// Query current frequency (Hz)
const hz = await rig.readOperatingFrequency({ timeout: 3000 });
console.log('Rig freq:', hz);

// Toggle PTT and send a short 1 kHz tone
await rig.setPtt(true);
for (let n = 0; n < 10; n++) {
  const tone = new Float32Array(240);
  for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2*Math.PI*1000*i/AUDIO_RATE) * 0.2;
  rig.sendAudioFloat32(tone);
  await new Promise(r => setTimeout(r, 20));
}
await rig.setPtt(false);

// Read meters and connector settings
const swr = await rig.readSWR({ timeout: 2000 });
const alc = await rig.readALC({ timeout: 2000 });
const wlanLevel = await rig.getConnectorWLanLevel({ timeout: 2000 });
const level = await rig.getLevelMeter({ timeout: 1500 });
await rig.setConnectorWLanLevel(0x0120);
await rig.setConnectorDataMode(0x01); // e.g., DATA

if (level) {
  console.log(`Generic Level Meter: raw=${level.raw} (${level.percent.toFixed(1)}%)`);
}
```

## Design Notes

- Packets follow Icom’s UDP framing: fixed headers with mixed endianness. See `src/core/IcomPackets.ts` for builders/parsers.
- Separate UDP session with tracked sequence numbers and resend history (skeleton) in `src/core/Session.ts`.
- CI‑V and Audio sub‑channels reuse the same UDP transport here; radios expose distinct ports after 0x50. You can adapt by creating additional `Session` instances bound to those ports if desired.
- Credentials use the same simple substitution cipher as FT8CN’s Android client (`passCode`).
- The 0x90/0x50 handshake strictly follows FT8CN’s timing and endianness. We pre‑open local CIV/Audio sockets, reply with local ports on first 0x90, then set remote ports upon 0x50.
- CIV/audio sub‑sessions each run their own Ping/Idle and (for CIV) OpenClose keep‑alive.

### Endianness and parsing tips

- Always use helpers from `src/utils/codec.ts` (`be16/be32/le16/le32`) when reading/writing packet fields.
- Do not call `Buffer.readUInt16LE/BE` or `Buffer.readUInt32LE/BE` directly for protocol fields in new code.
- See `CLAUDE.md` and `ENDIAN_VERIFICATION.md` for a complete cross‑check against FT8CN’s Java code. The Java names are misleading; TypeScript names reflect the actual endianness (be=Big‑Endian, le=Little‑Endian).

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
