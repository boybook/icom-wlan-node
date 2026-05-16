# icom-wlan-node

Icom WLAN (UDP) protocol implementation in Node.js + TypeScript, featuring:

CI-V profile support is Hamlib-aligned for modern ICOM radios: WLAN UDP packets carry standard CI-V frames, with model-specific profiles for IC-705, IC-905, IC-7300, IC-9700, IC-7610, and IC-7760.

- Control channel handshake (AreYouThere/AreYouReady), login (0x80/0x60), token confirm/renew (0x40)
- CI‑V over UDP encapsulation (open/close keep‑alive + CIV frame transport)
- Scope/spectrum data capture over CI‑V `0x27`, with automatic segment assembly into friendly frame events
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
import { IcomControl, AUDIO_RATE, DisconnectReason } from 'icom-wlan-node';

const rig = new IcomControl({
  control: { ip: '192.168.1.50', port: 50001 },
  userName: 'user',
  password: 'pass',
  model: 'auto' // or force a profile, e.g. 'IC-705'
});

rig.events.on('login', (res) => {
  if (res.ok) console.log('Login OK');
  else console.error('Login failed', res.errorCode);
});

rig.events.on('status', (s) => {
  console.log('Ports:', s.civPort, s.audioPort);
});

rig.events.on('capabilities', (c) => {
  console.log('CIV address:', c.civAddress, 'audio:', c.audioName, 'profile:', c.profileName);
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

rig.events.on('scopeFrame', (frame) => {
  console.log(
    'Scope:',
    `${frame.startFreqHz}..${frame.endFreqHz} Hz`,
    `pixels=${frame.pixels.length}`,
    `mode=${frame.mode}`
  );
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

### Main Rig Control Usage

Modern ICOM LAN/WLAN radios still transport standard serial CI‑V frames inside the UDP CIV payload. `icom-wlan-node` selects a model profile automatically from the radio name or CI‑V address, or you can force one with `model`.

```ts
const rig = new IcomControl({
  control: { ip: '192.168.1.50', port: 50001 },
  userName: 'icom',
  password: 'icomicom',
  model: 'auto' // 'IC-705', 'IC-905', 'IC-7300', 'IC-9700', 'IC-7610', 'IC-7760'
});

await rig.connect();

// Frequency and mode are profile-aware:
// modern profiles use CI-V 0x25/0x26, legacy fallback uses 0x05/0x06.
await rig.setFrequency(14074000);
await rig.setMode('USB', { dataMode: true, filter: 1 }); // USB-D, filter 1

const freqHz = await rig.readOperatingFrequency();
const mode = await rig.readOperatingMode();
const tx = await rig.readPtt();
console.log({ freqHz, mode, state: tx ? 'TX' : 'RX' });

// Tuner uses Hamlib-aligned CI-V 0x1C/0x01.
const tuner = await rig.readTunerStatus();
await rig.setTunerEnabled(true);

// Meters use active-profile calibration tables.
const swr = await rig.readSWR();
const power = await rig.readPowerLevel();
console.log({ tuner, swr, watts: power?.watts, powerPercent: power?.percent });
```

Profile-specific behavior includes IC-905 6-byte frequency BCD above 5.85 GHz, model-specific scope fixed-edge ranges, and calibrated SWR/ALC/RF power/COMP/voltage/current meters. Private connector commands such as WLAN level or connector data mode are only enabled when the active profile declares the vendor extension; unsupported writes throw `UnsupportedCommandError`.

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

### Scope / Spectrum

```ts
await rig.connect();

rig.events.on('scopeSegment', (segment) => {
  console.log(`scope segment ${segment.sequence}/${segment.sequenceMax}`);
});

rig.events.on('scopeFrame', (frame) => {
  console.log('scope frame ready', {
    startFreqHz: frame.startFreqHz,
    endFreqHz: frame.endFreqHz,
    pixelCount: frame.pixels.length,
    outOfRange: frame.outOfRange
  });
});

// Enable basic scope output
await rig.enableScope();

// Wait for one complete frame
const frame = await rig.waitForScopeFrame({ timeout: 3000 });
if (frame) {
  console.log(frame.pixels[0], frame.pixels[1]);
}

// Disable scope output when finished
await rig.disableScope();
```

## API Overview

- `new IcomControl(options)` — `options.model` may be `'auto'` or a supported model profile such as `'IC-705'`, `'IC-905'`, `'IC-7300'`, `'IC-9700'`, `'IC-7610'`, or `'IC-7760'`
  - `options.control`: `{ ip, port }` radio control UDP endpoint
  - `options.userName`, `options.password`
- Events (`rig.events.on(...)`)
  - `login(LoginResult)` — 0x60 processed (ok/error)
  - `status(StatusInfo)` — CI‑V/audio ports from 0x50
  - `capabilities(CapabilitiesInfo)` — civ address, audio name (0xA8)
  - `civ(Buffer)` — raw CI‑V payload bytes as transported over UDP
  - `civFrame(Buffer)` — one complete CI‑V frame (FE FE ... FD)
  - `scopeSegment(IcomScopeSegmentInfo)` — one parsed `0x27` scope segment
  - `scopeFrame(IcomScopeFrame)` — one assembled spectrum/waterfall frame
  - `audio({ pcm16: Buffer })` — audio frames
  - `error(Error)` — UDP errors
  - `connectionLost(ConnectionLostInfo)` — session timeout detected
  - `connectionRestored(ConnectionRestoredInfo)` — reconnected successfully
  - `reconnectAttempting(ReconnectAttemptInfo)` — reconnect attempt started
  - `reconnectFailed(ReconnectFailedInfo)` — reconnect attempt failed
- Methods
  - **Connection**: `connect()` / `disconnect(options?)` — connects control + CIV + audio sub‑sessions; resolves when all ready
    - `disconnect()` accepts optional `DisconnectOptions` or `DisconnectReason` for better error handling
  - **Raw CI‑V**: `sendCiv(buf: Buffer)` — send a raw CI‑V frame
  - **Scope / Spectrum**: `scope`, `enableScope()`, `disableScope()`, `waitForScopeFrame()`
  - **Audio TX**: `setPtt(on: boolean)`, `sendAudioFloat32()`, `sendAudioPcm16()`
  - **Rig Control**: `setFrequency()`, `setMode()`, `setConnectorDataMode()`, `setConnectorWLanLevel()`
  - **Rig Query**: `readOperatingFrequency()`, `readOperatingMode()`, `readTransmitFrequency()`, `readPtt()`, `readTransceiverState()`, `readBandEdges()`
  - **Antenna Tuner**: `readTunerStatus()`, `setTunerEnabled()`, `startManualTune()`
  - **Meters (RX)**: `readSquelchStatus()`, `readAudioSquelch()`, `readOvfStatus()`, `getLevelMeter()`
  - **Meters (TX)**: `readSWR()`, `readALC()`, `readPowerLevel()`, `readCompLevel()`
  - **Power Supply**: `readVoltage()`, `readCurrent()`
  - **Audio Config**: `getUsbAfLevel()`, `setUsbAfLevel()`, `getConnectorWLanLevel()`
  - **Connection Monitoring**: `getConnectionPhase()`, `getConnectionMetrics()`, `getConnectionState()`, `isAnySessionDisconnected()`, `configureMonitoring()`

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

// Disconnect with reason (provides better error messages)
await rig.disconnect(DisconnectReason.TIMEOUT);

// Silent disconnect (cleanup mode - no error events)
await rig.disconnect({ reason: DisconnectReason.CLEANUP, silent: true });
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

- `setFrequency(hz: number)` — Set operating frequency in Hz; modern profiles use targetable CI-V `0x25`, and IC-905 uses 6-byte BCD above 5.85 GHz
- `setMode(mode: IcomMode | number, options?: { dataMode?: boolean; filter?: 1|2|3 })` — Set mode; modern profiles use CI-V `0x26` with VFO, data-mode and filter
- `setPtt(on: boolean)` — Key/unkey transmitter

**Supported Modes** (IcomMode string constants):
- `'LSB'`, `'USB'`, `'AM'`, `'CW'`, `'RTTY'`, `'FM'`, `'WFM'`, `'CW_R'`, `'RTTY_R'`, `'DV'`
- Or use numeric codes: `0x00` (LSB), `0x01` (USB), `0x02` (AM), etc.

#### Rig Query

- `readOperatingFrequency(options?: QueryOptions) => Promise<number|null>`
- `readOperatingMode(options?: QueryOptions) => Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string; dataMode?: boolean } | null>`
- `readTransmitFrequency(options?: QueryOptions) => Promise<number|null>`
- `readPtt(options?: QueryOptions) => Promise<boolean|null>`
- `readTransceiverState(options?: QueryOptions) => Promise<'TX' | 'RX' | 'UNKNOWN' | null>`
- `readBandEdges(options?: QueryOptions) => Promise<Buffer|null>`

#### Scope / Spectrum

- `scope: IcomScopeService` — Standalone scope service object that can be reused with other CI‑V transport paths in the future
- `enableScope() => Promise<void>` — Send the minimal command sequence to enable basic scope output
- `disableScope() => Promise<void>` — Send the minimal command sequence to disable scope output
- `readScopeMode(options?: QueryOptions & { receiver?: 0 | 1 }) => Promise<IcomScopeModeInfo | null>` — Read current scope mode using CI‑V `0x27 0x14`
- `setScopeMode(mode: IcomScopeMode | 0 | 1 | 2 | 3, options?: { receiver?: 0 | 1 }) => Promise<void>` — Set current scope mode
- `readScopeSpan(options?: QueryOptions & { receiver?: 0 | 1 }) => Promise<{ receiver: 0 | 1; spanHz: number } | null>` — Read current scope span
- `setScopeSpan(spanHz: number, options?: { receiver?: 0 | 1 }) => Promise<void>` — Set public scope span using CI‑V `0x27 0x15`; the wire value is `spanHz / 2` per Hamlib
- `readScopeEdge(options?: QueryOptions & { receiver?: 0 | 1 }) => Promise<IcomScopeEdgeInfo | null>` — Read active fixed-edge slot using CI‑V `0x27 0x16`
- `setScopeEdge(edgeSlot: number, options?: { receiver?: 0 | 1 }) => Promise<void>` — Select active fixed-edge slot
- `readScopeFixedEdge(rangeId: number, edgeSlot: number, options?: QueryOptions) => Promise<IcomScopeFixedEdgeInfo | null>` — Read fixed-edge frequencies using CI‑V `0x27 0x1E`
- `setScopeFixedEdge({ rangeId?, edgeSlot?, lowHz, highHz }) => Promise<IcomScopeFixedEdgeInfo>` — Set fixed-edge frequencies, auto-resolving `rangeId` from the current rig frequency when omitted
- `resolveScopeFrequencyRangeId(frequencyHz?: number) => Promise<number>` — Resolve ICOM fixed-edge range ID from a target or current operating frequency
- `getSpectrumMode()/setSpectrumMode()` / `getSpectrumSpan()/setSpectrumSpan()` / `getSpectrumEdgeSlot()/setSpectrumEdgeSlot()` / `getSpectrumFixedEdges()/setSpectrumFixedEdges()` — Hamlib-like convenience aliases over the scope-specific methods
- `getSpectrumDisplayState(options?: QueryOptions & { receiver?: 0 | 1 }) => Promise<IcomSpectrumDisplayState>` — Read a Hamlib-like normalized display state
- `configureSpectrumDisplay(config?: IcomSpectrumDisplayConfig) => Promise<IcomSpectrumDisplayState>` — Apply a normalized display config covering center/fixed modes
- `waitForScopeFrame(options?: QueryOptions) => Promise<IcomScopeFrame | null>` — Wait for the next complete scope frame

`IcomScopeFrame` shape:

```ts
interface IcomScopeFrame {
  valid: boolean;
  receiver: 0 | 1;
  sequence: number;
  sequenceMax: number;
  mode: 0 | 1 | 2 | 3;
  outOfRange: boolean;
  startFreqHz: number;
  endFreqHz: number;
  pixels: Uint8Array;
  rawCivPayloads: Buffer[];
  transport: 'lan-civ' | 'serial';
}
```

Current implementation notes:

- Implements basic on/off controls, `0x27 0x15` span read/write, fixed-edge selection/ranges, and `0x27 00 00` scope data capture
- The parsing layer is decoupled from the UDP session layer and only depends on complete CI‑V frames
- Frequency and fixed-edge ranges are profile-aware; unsupported model-specific variants should be added in `src/rig/IcomProfiles.ts`
- LAN aggregate waterfall payload splitting is not implemented yet; standard segment input is supported
- The `scope` logic is designed to be reusable for future serial CI‑V or Hamlib CI‑V integration

#### Antenna Tuner (ATU)

- `readTunerStatus(options?: QueryOptions) => Promise<{ raw: number; state: 'OFF'|'ON'|'TUNING' } | null>` — Read tuner status (Hamlib-aligned CI-V `0x1C 0x01`)
- `setTunerEnabled(enabled: boolean) => Promise<void>` — Enable/disable internal tuner (Hamlib-aligned CI‑V `0x1C 0x01 0x00/0x01`)
- `startManualTune() => Promise<void>` — Trigger one manual tune cycle (Hamlib-aligned CI‑V `0x1C 0x01 0x02`)

#### Meters & Levels

**Reception Meters** (available anytime):
- `readSquelchStatus(options?: QueryOptions) => Promise<{ raw: number; isOpen: boolean } | null>` — Squelch gate state (CI-V 0x15/0x01)
- `readAudioSquelch(options?: QueryOptions) => Promise<{ raw: number; isOpen: boolean } | null>` — Audio squelch state (CI-V 0x15/0x05)
- `readOvfStatus(options?: QueryOptions) => Promise<{ raw: number; isOverload: boolean } | null>` — ADC overload detection (CI-V 0x15/0x07)
- `getLevelMeter(options?: QueryOptions) => Promise<{ raw: number; percent: number; sUnits: number; dbAboveS9?: number; dBm: number; formatted: string } | null>` — S-meter (signal strength) with physical units (CI-V 0x15/0x02)

**Transmission Meters** (require PTT on):
- `readSWR(options?: QueryOptions) => Promise<{ raw: number; swr: number; alert: boolean } | null>` — SWR meter (CI-V 0x15/0x12)
- `readALC(options?: QueryOptions) => Promise<{ raw: number; percent: number; alert: boolean } | null>` — ALC meter (CI-V 0x15/0x13)
- `readPowerLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number; watts?: number } | null>` — Output power level (CI-V 0x15/0x11)
- `readCompLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number; db?: number } | null>` — Voice compression level (CI-V 0x15/0x14)

**Power Supply Monitoring**:
- `readVoltage(options?: QueryOptions) => Promise<{ raw: number; volts: number } | null>` — Supply voltage (CI-V 0x15/0x15)
- `readCurrent(options?: QueryOptions) => Promise<{ raw: number; amps: number } | null>` — Supply current draw (CI-V 0x15/0x16)

**Audio Configuration**:
- `getUsbAfLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>` / `setUsbAfLevel(level: number)` — Hamlib-aligned USB AF level when the active profile declares it
- `getConnectorWLanLevel(options?: QueryOptions) => Promise<{ raw: number; percent: number } | null>` / `setConnectorWLanLevel(level: number)` — Private `icom-wlan-node` WLAN level extension; returns `null` or throws `UnsupportedCommandError` when the active profile does not declare it

#### Connector Settings

- `setConnectorDataMode(mode: ConnectorDataMode | number)` — Private connector routing extension; supported only on profiles that declare the vendor command

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

// Read reception meters (available anytime)
const squelch = await rig.readSquelchStatus({ timeout: 2000 });
if (squelch) {
  console.log(`Squelch: ${squelch.isOpen ? 'OPEN' : 'CLOSED'}`);
}

const audioSq = await rig.readAudioSquelch({ timeout: 2000 });
if (audioSq) {
  console.log(`Audio Squelch: ${audioSq.isOpen ? 'OPEN' : 'CLOSED'}`);
}

const ovf = await rig.readOvfStatus({ timeout: 2000 });
if (ovf) {
  console.log(`ADC: ${ovf.isOverload ? '⚠️ OVERLOAD' : '✓ OK'}`);
}

const sMeter = await rig.getLevelMeter({ timeout: 2000 });
if (sMeter) {
  console.log(`S-Meter: ${sMeter.formatted} (${sMeter.sUnits.toFixed(1)} S-units, ${sMeter.dBm.toFixed(1)} dBm)`);
  // Example output: "S-Meter: S9+10dB (9.9 S-units, -63.1 dBm)"
}

// Read power supply monitoring
const voltage = await rig.readVoltage({ timeout: 2000 });
if (voltage) {
  console.log(`Voltage: ${voltage.volts.toFixed(2)}V`);
}

const current = await rig.readCurrent({ timeout: 2000 });
if (current) {
  console.log(`Current: ${current.amps.toFixed(2)}A`);
}

// Read transmission meters (requires PTT on)
await rig.setPtt(true);
await new Promise(r => setTimeout(r, 200)); // Wait for meters to stabilize

const swr = await rig.readSWR({ timeout: 2000 });
if (swr) {
  console.log(`SWR: ${swr.swr.toFixed(2)} ${swr.alert ? '⚠️ HIGH' : '✓'}`);
}

const alc = await rig.readALC({ timeout: 2000 });
if (alc) {
  console.log(`ALC: ${alc.percent.toFixed(1)}% ${alc.alert ? '⚠️ HIGH' : '✓'}`);
}

const power = await rig.readPowerLevel({ timeout: 2000 });
if (power) {
  console.log(`Power: ${power.percent.toFixed(1)}%${power.watts != null ? ` (${power.watts.toFixed(1)} W)` : ''}`);
}

const comp = await rig.readCompLevel({ timeout: 2000 });
if (comp) {
  console.log(`COMP: ${comp.percent.toFixed(1)}%${comp.db != null ? ` (${comp.db.toFixed(1)} dB)` : ''}`);
}

await rig.setPtt(false);

// Configure WLAN connector (private extension; profile-gated)
const wlanLevel = await rig.getConnectorWLanLevel({ timeout: 2000 });
if (wlanLevel) {
  console.log(`WLAN Level: ${wlanLevel.percent.toFixed(1)}%`);
}

// Set connector to WLAN mode using string constant
await rig.setConnectorDataMode('WLAN');
// Or numeric: await rig.setConnectorDataMode(0x03);

await rig.setConnectorWLanLevel(120); // Set WLAN audio level

// Scope capture
await rig.enableScope();
const scope = await rig.waitForScopeFrame({ timeout: 3000 });
if (scope) {
  console.log(`Scope ${scope.startFreqHz}..${scope.endFreqHz}, ${scope.pixels.length} pixels`);
}
await rig.disableScope();

// Antenna tuner
const atu = await rig.readTunerStatus({ timeout: 2000 });
if (atu) {
  console.log('ATU:', atu.state);
}

await rig.setTunerEnabled(true);
await rig.startManualTune();
```

## Design Notes

- Packets follow Icom’s UDP framing: fixed headers with mixed endianness. See `src/core/IcomPackets.ts` for builders/parsers.
- Separate UDP session with tracked sequence numbers and resend history (skeleton) in `src/core/Session.ts`.
- CI‑V and Audio sub‑channels reuse the same UDP transport here; radios expose distinct ports after 0x50. You can adapt by creating additional `Session` instances bound to those ports if desired.
- Credentials use the same simple substitution cipher as FT8CN’s Android client (`passCode`).
- The 0x90/0x50 handshake strictly follows FT8CN’s timing and endianness. We pre‑open local CIV/Audio sockets, reply with local ports on first 0x90, then set remote ports upon 0x50.
- CIV/audio sub‑sessions each run their own Ping/Idle and (for CIV) OpenClose keep‑alive.
- Scope data is treated as CI‑V business payload, not as a separate UDP stream. `IcomControl` only bridges CI‑V frames into the reusable `IcomScopeService`.

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
- Scope support includes basic enable/disable, mode/span/edge/fixed-edge control, and standard `0x27 00 00` segment parsing.
- LAN aggregate waterfall payload splitting is not implemented yet.

## License

MIT
