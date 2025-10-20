/**
 * Integration test against a real Icom WLAN radio.
 *
 * This test is skipped unless these env vars are present:
 *  - ICOM_IP: radio IP
 *  - ICOM_PORT: radio control UDP port (e.g., 50001)
 *  - ICOM_USER: username
 *  - ICOM_PASS: password
 * Optional:
 *  - ICOM_TEST_PTT=true to exercise PTT and short audio TX (be careful: this keys TX!)
 * Example:
 *  DEBUG_ICOM_LEVEL=0 ICOM_IP=192.168.31.199 ICOM_PORT=50001 ICOM_USER=icom ICOM_PASS=icomicom ICOM_TEST_PTT=true ts-node demo.ts
 */

import { IcomControl, AUDIO_RATE, IcomRigCommands } from './src';
import { hex as hexStr } from './src/utils/codec';

async function test() {
  const ip = process.env.ICOM_IP!;
  const port = parseInt(process.env.ICOM_PORT!, 10);
  const user = process.env.ICOM_USER!;
  const pass = process.env.ICOM_PASS!;
  const testPTT = process.env.ICOM_TEST_PTT === 'true';

  const t0 = Date.now();
  const stamp = () => `+${(Date.now() - t0).toString().padStart(4)}ms`;
  const rig = new IcomControl({ control: { ip, port }, userName: user, password: pass });

  let gotLogin = false;
  let gotStatus = false;
  let gotCap = false;
  let civCount = 0;
  let audioCount = 0;

  const wait = (cond: () => boolean, ms = 30000) => new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) { clearInterval(t); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(t); reject(new Error('timeout')); }
    }, 100);
  });

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  const onLogin = (res: any) => {
    console.log(stamp(), 'login event ok=', res.ok, 'error?', res.errorCode, 'conn=', res.connection);
    gotLogin = res.ok;
  };
  const onStatus = (s: any) => {
    console.log(stamp(), 'status civPort=', s.civPort, 'audioPort=', s.audioPort, 'authOK=', s.authOK, 'connected=', s.connected);
    gotStatus = true;
  };
  const onCap = (c: any) => {
    console.log(stamp(), 'capabilities civAddr=', c.civAddress, 'audioName=', c.audioName, 'supportTX=', c.supportTX);
    gotCap = true;
  };
  const onCiv = (frame: Buffer) => {
    civCount++;
    if (civCount <= 3) console.log(stamp(), `CIV[${civCount}]`, hexStr(frame.subarray(0, Math.min(16, frame.length))));
  };
  const onAudio = (p: { pcm16: Buffer }) => {
    audioCount++;
    if (audioCount % 10 === 0) console.log(stamp(), `AUDIO[${audioCount}] len=`, p.pcm16.length);
  };
  rig.events.on('login', onLogin);
  rig.events.on('status', onStatus);
  rig.events.on('capabilities', onCap);
  rig.events.on('civ', onCiv);
  rig.events.on('audio', onAudio);

  console.log(stamp(), 'connecting to', ip, port);
  await rig.connect();

// Wait for login + status
  console.log(stamp(), 'waiting login+status ...');
  await wait(() => gotLogin && gotStatus, 20000);
  console.log(stamp(), 'login+status OK');

// Expect at least capabilities soon
  console.log(stamp(), 'waiting capabilities (0xA8) ...');
  await wait(() => gotCap, 8000).catch(() => { console.log(stamp(), 'capabilities timeout (tolerated)'); });

// Ensure data mode and connector routing favor WLAN before CIV queries
  console.log(stamp(), 'setMode USB-D (data) and route data to WLAN');
  await rig.setMode('USB', { dataMode: true });
  await rig.setConnectorDataMode('WLAN');

// Issue a CIV read operating frequency; expect some CIV traffic
  const rigAddr = rig.civ.civAddress & 0xff;
  const ctrAddr = 0xe0;
  const readFreq = IcomRigCommands.readOperatingFrequency(ctrAddr, rigAddr);
  const civBefore = civCount;
  rig.sendCiv(readFreq);
  console.log(stamp(), 'sent CIV read frequency, waiting CIV traffic ...');
  await wait(() => civCount > civBefore, 6000).catch(() => {});

// High-level: query frequency, set mode to USB-D (data), adjust frequency slightly and revert
  const curHz = await rig.readOperatingFrequency({ timeout: 8000 });
  if (curHz) {
    console.log(stamp(), 'readOperatingFrequency =', curHz);
    // Set data mode USB-D
    console.log(stamp(), 'setMode USB-D');
    await rig.setMode('USB', { dataMode: true });
    // Route connector data to WLAN (best effort)
    console.log(stamp(), 'setConnectorDataMode WLAN');
    await rig.setConnectorDataMode('WLAN');

    // Nudge frequency by +50 Hz then revert
    const newHz = curHz + 50;
    console.log(stamp(), 'setFrequency to', newHz);
    await rig.setFrequency(newHz);
    const backHz = await rig.readOperatingFrequency({ timeout: 4000 });
    console.log(stamp(), 'verify freq after set =', backHz);
    console.log(stamp(), 'revert frequency to', curHz);
    await rig.setFrequency(curHz);
  } else {
    console.log(stamp(), 'readOperatingFrequency returned null (tolerated)');
  }

// ============================================================================
  // API Demo: Demonstrate all available APIs and print their results
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log(stamp(), '🎯 API DEMONSTRATION - Testing all available methods');
  console.log('='.repeat(80) + '\n');

  // 1. Mode APIs
  console.log(stamp(), '📡 Testing Mode APIs:');
  console.log(stamp(), '  → Setting mode to LSB (Lower Side Band)');
  await rig.setMode('LSB');
  await sleep(500);
  console.log(stamp(), '  → Setting mode to USB (Upper Side Band)');
  await rig.setMode('USB');
  await sleep(500);
  console.log(stamp(), '  → Setting mode to USB-D (Data mode for FT8)');
  await rig.setMode('USB', { dataMode: true });
  await sleep(500);

  // 2. Frequency APIs
  console.log(stamp(), '\n📻 Testing Frequency APIs:');
  const currentFreq = await rig.readOperatingFrequency({ timeout: 3000 });
  if (currentFreq) {
    console.log(stamp(), `  ✓ Current frequency: ${(currentFreq / 1000000).toFixed(3)} MHz (${currentFreq} Hz)`);

    // Test frequency change
    const testFreq = 14074000; // FT8 on 20m
    console.log(stamp(), `  → Setting frequency to ${(testFreq / 1000000).toFixed(3)} MHz`);
    await rig.setFrequency(testFreq);
    await sleep(500);

    const verifyFreq = await rig.readOperatingFrequency({ timeout: 3000 });
    if (verifyFreq) {
      console.log(stamp(), `  ✓ Verified frequency: ${(verifyFreq / 1000000).toFixed(3)} MHz`);
    }

    // Restore original frequency
    console.log(stamp(), `  → Restoring original frequency: ${(currentFreq / 1000000).toFixed(3)} MHz`);
    await rig.setFrequency(currentFreq);
    await sleep(500);
  } else {
    console.log(stamp(), '  ✗ Failed to read current frequency');
  }

  // 3. Connector APIs
  console.log(stamp(), '\n🔌 Testing Connector APIs:');
  console.log(stamp(), '  → Setting connector data mode to WLAN');
  await rig.setConnectorDataMode('WLAN');
  await sleep(500);

  const wlanLevel = await rig.getConnectorWLanLevel({ timeout: 2000 });
  if (wlanLevel) {
    console.log(stamp(), `  ✓ WLAN Level: ${wlanLevel.percent.toFixed(1)}% (raw=${wlanLevel.raw}/255)`);
  } else {
    console.log(stamp(), '  ℹ WLAN Level: Not available (may not be supported on this radio)');
  }

  // Test setting WLAN level
  console.log(stamp(), '  → Setting WLAN level to 128 (50%)');
  await rig.setConnectorWLanLevel(128);
  await sleep(500);

  const newWlanLevel = await rig.getConnectorWLanLevel({ timeout: 2000 });
  if (newWlanLevel) {
    console.log(stamp(), `  ✓ New WLAN Level: ${newWlanLevel.percent.toFixed(1)}% (raw=${newWlanLevel.raw}/255)`);
  }

  // 4. Summary of RX-mode readings
  console.log(stamp(), '\n📋 Summary of Current Radio State (RX mode):');
  console.log(stamp(), '  ╔═══════════════════════════════════════════════════════╗');
  if (currentFreq) {
    console.log(stamp(), `  ║ Frequency: ${(currentFreq / 1000000).toFixed(3).padEnd(10)} MHz                         ║`);
  }
  console.log(stamp(), `  ║ Mode:      USB-D (Data mode)                          ║`);
  console.log(stamp(), `  ║ Connector: WLAN                                       ║`);
  if (newWlanLevel) {
    console.log(stamp(), `  ║ WLAN Level: ${newWlanLevel.percent.toFixed(1).padEnd(5)}%                                    ║`);
  }
  console.log(stamp(), '  ╚═══════════════════════════════════════════════════════╝');

  console.log(stamp(), '\n  ℹ️  Note: Meter readings (SWR/ALC) require TX mode - see PTT test below');

  console.log('\n' + '='.repeat(80));
  console.log(stamp(), '✅ API DEMONSTRATION COMPLETE (RX mode)');
  console.log('='.repeat(80) + '\n');

// Expect to receive at least some audio frames if radio is streaming
  console.log(stamp(), 'waiting audio frames ...');
  await wait(() => audioCount > 0, 6000).catch(() => {});

  // Try reading additional CIV info in RX mode
  try {
    const mode = await rig.readOperatingMode({ timeout: 1500 });
    if (mode) {
      const modeStr = mode.modeName ?? `0x${mode.mode.toString(16)}`;
      const filStr = mode.filterName ?? (mode.filter !== undefined ? `FIL${mode.filter}` : '');
      console.log(stamp(), `RX: Operating Mode = ${modeStr}${filStr ? `, ${filStr}` : ''}`);
    } else {
      console.log(stamp(), 'RX: Operating Mode: Not available');
    }
  } catch {}
  try {
    const edges = await rig.readBandEdges({ timeout: 1500 });
    if (edges) {
      console.log(stamp(), `RX: Band edges payload length: ${edges.length} bytes`);
    } else {
      console.log(stamp(), 'RX: Band edges: Not available');
    }
  } catch {}

// Optional: brief PTT + short audio TX (dangerous; keys TX)
  if (testPTT && gotLogin && gotStatus) {
    console.log('\n' + '='.repeat(80));
    console.log(stamp(), '📡 PTT TEST & METER READINGS (TX MODE)');
    console.log('='.repeat(80) + '\n');

    // Ensure audio routing is set to WLAN before PTT
    console.log(stamp(), '→ Setting connector data mode to WLAN before PTT');
    await rig.setConnectorDataMode('WLAN');

    console.log(stamp(), '→ PTT ON - Starting transmission');
    await rig.setPtt(true);

    // Wait a moment for TX to stabilize
    await sleep(500);

    // Generate all audio frames at once (10 seconds of 1 kHz tone)
    const frames = 500; // 500 * 20ms = 10000ms = 10 seconds
    const samplesPerFrame = 240;
    const totalSamples = frames * samplesPerFrame;
    const allAudio = new Float32Array(totalSamples);

    // Generate 1 kHz tone for entire duration
    for (let i = 0; i < totalSamples; i++) {
      allAudio[i] = Math.sin(2 * Math.PI * 1000 * i / AUDIO_RATE) * 0.2;
    }

    // Add all audio to queue at once with leading silence buffer
    console.log(stamp(), '→ Enqueuing', frames, 'frames of audio (1kHz tone, 10 seconds)');
    rig.sendAudioFloat32(allAudio, true); // true = add leading silence buffer

    // ============================================================================
    // 📊 Testing Meter APIs during TX
    // ============================================================================
    console.log(stamp(), '\n📊 Reading Meters during TX:');

    // Also read TX-related CIV info
    try {
      const txHz = await rig.readTransmitFrequency({ timeout: 1500 });
      if (txHz) console.log(stamp(), `  TX Frequency: ${txHz} Hz`);
      else console.log(stamp(), '  TX Frequency: Not available');
    } catch {}
    try {
      const state = await rig.readTransceiverState({ timeout: 1500 });
      if (state) console.log(stamp(), `  Transceiver State: ${state}`);
      else console.log(stamp(), '  Transceiver State: Not available');
    } catch {}

    // Read meters multiple times during transmission to get stable readings
    const meterReadings: { swr: any[], alc: any[] } = { swr: [], alc: [] };

    for (let i = 0; i < 3; i++) {
      await sleep(1000); // Wait 1 second between readings

      console.log(stamp(), `  → Reading meters (${i + 1}/3)...`);

      const swr = await rig.readSWR({ timeout: 2000 });
      if (swr) {
        meterReadings.swr.push(swr);
        const swrStatus = swr.alert ? '⚠️  ALERT' : '✓ OK';
        console.log(stamp(), `    SWR: ${swr.swr.toFixed(2)} (raw=${swr.raw}) ${swrStatus}`);
      } else {
        console.log(stamp(), `    SWR: Not available`);
      }

      const alc = await rig.readALC({ timeout: 2000 });
      if (alc) {
        meterReadings.alc.push(alc);
        const alcStatus = alc.alert ? '⚠️  ALERT' : '✓ OK';
        console.log(stamp(), `    ALC: ${alc.percent.toFixed(1)}% (raw=${alc.raw}) ${alcStatus}`);
      } else {
        console.log(stamp(), `    ALC: Not available`);
      }
    }

    // Calculate and display average readings
    if (meterReadings.swr.length > 0) {
      const avgSwr = meterReadings.swr.reduce((sum, r) => sum + r.swr, 0) / meterReadings.swr.length;
      const hasAlert = meterReadings.swr.some(r => r.alert);
      console.log(stamp(), '\n  📈 Average SWR Reading:');
      console.log(stamp(), `    - Average Value: ${avgSwr.toFixed(2)}`);
      console.log(stamp(), `    - Status: ${hasAlert ? '⚠️  ALERT (High SWR detected!)' : '✓ OK'}`);
      console.log(stamp(), `    - Assessment: ${avgSwr < 1.5 ? 'Excellent antenna match' : avgSwr < 2.0 ? 'Good antenna match' : 'Poor antenna match - check connections'}`);
    }

    if (meterReadings.alc.length > 0) {
      const avgAlc = meterReadings.alc.reduce((sum, r) => sum + r.percent, 0) / meterReadings.alc.length;
      const hasAlert = meterReadings.alc.some(r => r.alert);
      console.log(stamp(), '\n  📈 Average ALC Reading:');
      console.log(stamp(), `    - Average Level: ${avgAlc.toFixed(1)}%`);
      console.log(stamp(), `    - Status: ${hasAlert ? '⚠️  ALERT (Over-driving!)' : '✓ OK'}`);
      console.log(stamp(), `    - Assessment: ${avgAlc < 30 ? 'Low drive - increase audio level' : avgAlc < 70 ? 'Normal operating range' : 'High drive - reduce audio level'}`);
    }

    // Wait for remaining transmission to complete
    const remainingTime = (frames * 21) - 3000; // Already waited 3 seconds for meter readings
    if (remainingTime > 0) {
      console.log(stamp(), `\n→ Waiting for transmission to complete (~${(remainingTime/1000).toFixed(1)}s remaining)`);
      await sleep(remainingTime);
    }

    await rig.setPtt(false);
    console.log(stamp(), '\n→ PTT OFF - Transmission complete, trailing silence sent');

    console.log('\n' + '='.repeat(80));
    console.log(stamp(), '✅ PTT TEST & METER READINGS COMPLETE');
    console.log('='.repeat(80) + '\n');

    await sleep(1000);
  }

  // Clean up listeners to help jest exit
  rig.events.off('login', onLogin);
  rig.events.off('status', onStatus);
  rig.events.off('capabilities', onCap);
  rig.events.off('civ', onCiv);
  rig.events.off('audio', onAudio);
  console.log(stamp(), 'summary: civ=', civCount, 'audio=', audioCount);
  console.log(stamp(), 'disconnecting...');
  await rig.disconnect();
  console.log(stamp(), 'disconnected');
}

test().then().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
})
