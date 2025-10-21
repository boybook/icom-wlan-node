# icom-wlan-node

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
npm install icom-wlan-node
```

Build from source:

```
npm install
npm run build
```

## Quick Start

```ts
import { IcomControl, AUDIO_RATE } from 'icom-wlan-node';

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
  - `connectionLost(ConnectionLostInfo)` — session timeout detected
  - `connectionRestored(ConnectionRestoredInfo)` — reconnected successfully
  - `reconnectAttempting(ReconnectAttemptInfo)` — reconnect attempt started
  - `reconnectFailed(ReconnectFailedInfo)` — reconnect attempt failed
- Methods
  - `connect()` / `disconnect()` — connects control + CIV + audio sub‑sessions; resolves when all ready
  - `sendCiv(buf: Buffer)` — send a raw CI‑V frame
  - `setPtt(on: boolean)` — key/unkey; also manages TX meter polling and audio tailing
  - `sendAudioFloat32(samples: Float32Array, addLeadingBuffer?: boolean)` / `sendAudioPcm16(samples: Int16Array)`
  - `getConnectionPhase()` — returns current ConnectionPhase (IDLE, CONNECTING, CONNECTED, DISCONNECTING, RECONNECTING)
  - `getConnectionMetrics()` — returns detailed ConnectionMetrics (phase, uptime, session states, etc.)
  - `getConnectionState()` — returns per‑session ConnectionState (control, civ, audio)
  - `isAnySessionDisconnected()` — returns true if any session is disconnected
  - `configureMonitoring(config)` — configure connection monitoring and auto‑reconnect behavior

### Connection Management & Auto-Reconnect

The library features a robust state machine for connection lifecycle management with automatic reconnection support.

#### Connection State Machine

```ts
ConnectionPhase: IDLE → CONNECTING → CONNECTED → DISCONNECTING
                   ↓                      ↓
                RECONNECTING ←────────────┘
```

#### Basic Usage

```ts
// Connect (idempotent - safe to call multiple times)
await rig.connect();

// Query connection phase
const phase = rig.getConnectionPhase(); // 'IDLE' | 'CONNECTING' | 'CONNECTED' | ...

// Get detailed metrics
const metrics = rig.getConnectionMetrics();
console.log(metrics.phase);       // Current phase
console.log(metrics.uptime);      // Milliseconds since connected
console.log(metrics.sessions);    // Per-session states {control, civ, audio}

// Disconnect (also idempotent)
await rig.disconnect();
```

#### Connection Monitoring Events

```ts
// Connection lost (any session timeout)
rig.events.on('connectionLost', (info) => {
  console.error(`Lost: ${info.sessionType}, idle: ${info.timeSinceLastData}ms`);
});

// Connection restored after reconnect
rig.events.on('connectionRestored', (info) => {
  console.log(`Restored after ${info.downtime}ms downtime`);
});

// Reconnect attempt started
rig.events.on('reconnectAttempting', (info) => {
  console.log(`Reconnect attempt #${info.attemptNumber}, delay: ${info.delay}ms`);
});

// Reconnect attempt failed
rig.events.on('reconnectFailed', (info) => {
  console.error(`Attempt #${info.attemptNumber} failed: ${info.error}`);
  if (!info.willRetry) console.error('Giving up - max retries reached');
});
```

#### Auto-Reconnect Configuration

```ts
rig.configureMonitoring({
  timeout: 8000,              // Session timeout: 8s (default: 5s)
  checkInterval: 1000,        // Check every 1s (default: 1s)
  autoReconnect: true,        // Enable auto-reconnect (default: false)
  maxReconnectAttempts: 10,   // Max retries (default: undefined = infinite)
  reconnectBaseDelay: 2000,   // Base delay: 2s (default: 2s)
  reconnectMaxDelay: 30000    // Max delay: 30s (default: 30s, uses exponential backoff)
});
```

**Exponential Backoff**: Delays are `baseDelay × 2^(attempt-1)`, capped at `maxDelay`.
Example: 2s → 4s → 8s → 16s → 30s (capped) → 30s ...

#### Error Handling

**Common Errors**:

```ts
try {
  await rig.connect();
} catch (err) {
  if (err.message.includes('timeout')) {
    // Connection timeout (no response from radio)
  } else if (err.message.includes('Login failed')) {
    // Authentication error (check userName/password)
  } else if (err.message.includes('Radio reported connected=false')) {
    // Radio rejected connection (may be busy with another client)
  } else if (err.message.includes('Cannot connect while disconnecting')) {
    // Invalid state transition (wait for disconnect to complete)
  }
}

// Listen for UDP errors
rig.events.on('error', (err) => {
  console.error('UDP error:', err.message);
  // Network issues, invalid packets, etc.
});
```

**Connection States to Handle**:
- **CONNECTING**: Wait or show "connecting..." UI
- **CONNECTED**: Normal operation
- **RECONNECTING**: Show "reconnecting..." UI, disable TX
- **DISCONNECTING**: Cleanup in progress
- **IDLE**: Not connected

### High‑Level API

The library exposes common CI‑V operations as friendly methods. Addresses are handled internally (`ctrAddr=0xe0`, `rigAddr` discovered via capabilities).

#### Rig Control

- `setFrequency(hz: number)` — Set operating frequency in Hz
- `setMode(mode: IcomMode | number, options?: { dataMode?: boolean })` — Set mode (supports string or numeric code)
- `setPtt(on: boolean)` — Key/unkey transmitter

**Supported Modes** (IcomMode string constants):
- `'LSB'`, `'USB'`, `'AM'`, `'CW'`, `'RTTY'`, `'FM'`, `'WFM'`, `'CW_R'`, `'RTTY_R'`, `'DV'`
- Or use numeric codes: `0x00` (LSB), `0x01` (USB), `0x02` (AM), etc.

#### Rig Query

- `readOperatingFrequency(options?: QueryOptions) => Promise<number|null>`
- `readOperatingMode(options?: QueryOptions) => Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string } | null>`
- `readTransmitFrequency(options?: QueryOptions) => Promise<number|null>`
- `readTransceiverState(options?: QueryOptions) => Promise<'TX' | 'RX' | 'UNKNOWN' | null>`
- `readBandEdges(options?: QueryOptions) => Promise<Buffer|null>`

#### Meters & Levels

- `readSWR(options?: QueryOptions) => Promise<{ raw: number; swr: number; alert: boolean } | null>`
- `readALC(options?: QueryOptions) => Promise<{ raw: number; percent: number; alert: boolean } | null>`
- `getConnectorWLanLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>`
- `getLevelMeter(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>`
- `setConnectorWLanLevel(level: number)` — Set WLAN audio level (0-255)

#### Connector Settings

- `setConnectorDataMode(mode: ConnectorDataMode | number)` — Set data routing mode (supports string or numeric)

**Supported Connector Modes** (ConnectorDataMode string constants):
- `'MIC'` (0x00), `'ACC'` (0x01), `'USB'` (0x02), `'WLAN'` (0x03)

#### Examples

```ts
// Set frequency and mode using string constants
await rig.setFrequency(14074000);
await rig.setMode('USB', { dataMode: true }); // USB-D for FT8

// Or use numeric codes
await rig.setMode(0x01, { dataMode: true }); // USB=0x01

// Set LSB mode
await rig.setMode('LSB');

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

// Set connector to WLAN mode using string constant
await rig.setConnectorDataMode('WLAN');
// Or numeric: await rig.setConnectorDataMode(0x03);

await rig.setConnectorWLanLevel(120); // Set WLAN audio level

if (wlanLevel) {
  console.log(`WLAN Level: ${wlanLevel.percent.toFixed(1)}%`);
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
