#!/usr/bin/env tsx
/**
 * Real-radio scope/spectrum capture script.
 *
 * Required env vars:
 *   ICOM_IP
 *   ICOM_PORT
 *   ICOM_USER
 *   ICOM_PASS
 *
 * Optional env vars:
 *   ICOM_SCOPE_FRAMES=3
 *   ICOM_SCOPE_TIMEOUT=10000
 *   ICOM_SCOPE_OUTPUT=./scope-capture.json
 *
 * Example:
 *   ICOM_IP=192.168.31.253 \
 *   ICOM_PORT=50001 \
 *   ICOM_USER=icom \
 *   ICOM_PASS=icomicom \
 *   ICOM_SCOPE_FRAMES=5 \
 *   tsx scripts/test-scope-real.ts
 */

import { writeFile } from 'fs/promises';
import { IcomControl, IcomScopeFrame } from '../src';

interface ScopeCaptureRecord {
  index: number;
  timestamp: string;
  startFreqHz: number;
  endFreqHz: number;
  mode: number;
  outOfRange: boolean;
  pixelCount: number;
  pixels: number[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const ip = requireEnv('ICOM_IP');
  const port = Number.parseInt(requireEnv('ICOM_PORT'), 10);
  const userName = requireEnv('ICOM_USER');
  const password = requireEnv('ICOM_PASS');
  const frameTarget = Number.parseInt(process.env.ICOM_SCOPE_FRAMES ?? '3', 10);
  const timeoutMs = Number.parseInt(process.env.ICOM_SCOPE_TIMEOUT ?? '10000', 10);
  const outputPath = process.env.ICOM_SCOPE_OUTPUT;

  const startedAt = Date.now();
  const stamp = () => `+${String(Date.now() - startedAt).padStart(5)}ms`;

  const rig = new IcomControl({
    control: { ip, port },
    userName,
    password
  });

  let gotLogin = false;
  let gotStatus = false;
  let gotCapabilities = false;
  let segmentCount = 0;
  const frames: ScopeCaptureRecord[] = [];

  const cleanup = async () => {
    try {
      await rig.disableScope();
    } catch {}
    try {
      await rig.disconnect({ silent: true });
    } catch {}
  };

  process.on('SIGINT', async () => {
    console.log(`\n${stamp()} Caught SIGINT, cleaning up...`);
    await cleanup();
    process.exit(130);
  });

  rig.events.on('login', (res) => {
    console.log(stamp(), 'login', res);
    gotLogin = res.ok;
  });

  rig.events.on('status', (status) => {
    console.log(stamp(), 'status', status);
    gotStatus = true;
  });

  rig.events.on('capabilities', (capabilities) => {
    console.log(stamp(), 'capabilities', capabilities);
    gotCapabilities = true;
  });

  rig.events.on('scopeSegment', (segment) => {
    segmentCount++;
    console.log(
      stamp(),
      `scope-segment #${segmentCount}`,
      `seq=${segment.sequence}/${segment.sequenceMax}`,
      `pixels=${segment.pixels?.length ?? 0}`
    );
  });

  rig.events.on('scopeFrame', (frame) => {
    const record: ScopeCaptureRecord = {
      index: frames.length + 1,
      timestamp: new Date().toISOString(),
      startFreqHz: frame.startFreqHz,
      endFreqHz: frame.endFreqHz,
      mode: frame.mode,
      outOfRange: frame.outOfRange,
      pixelCount: frame.pixels.length,
      pixels: Array.from(frame.pixels)
    };

    frames.push(record);
    logScopeFrame(stamp(), frame, record.index);
  });

  rig.events.on('error', (err) => {
    console.error(stamp(), 'error', err.message);
  });

  try {
    console.log(stamp(), `connecting to ${ip}:${port}`);
    await rig.connect();

    await waitFor(() => gotLogin && gotStatus, Math.min(timeoutMs, 20000), 'login/status');
    await waitFor(() => gotCapabilities, Math.min(timeoutMs, 8000), 'capabilities').catch(() => {
      console.log(stamp(), 'capabilities timeout (tolerated)');
    });

    console.log(stamp(), 'setting mode to USB-D and connector to WLAN');
    await rig.setMode('USB', { dataMode: true });
    await rig.setConnectorDataMode('WLAN');
    await sleep(300);

    console.log(stamp(), 'enabling scope output');
    await rig.enableScope();

    const deadline = Date.now() + timeoutMs;
    while (frames.length < frameTarget && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const frame = await rig.waitForScopeFrame({ timeout: remaining });
      if (!frame) break;
    }

    if (frames.length === 0) {
      throw new Error(`No scope frames captured within ${timeoutMs}ms`);
    }

    console.log('');
    console.log('Capture summary');
    console.log(`  frames:   ${frames.length}`);
    console.log(`  segments: ${segmentCount}`);
    console.log(`  span:     ${frames[0].startFreqHz} .. ${frames[0].endFreqHz} Hz`);
    console.log(`  pixels:   ${frames[0].pixelCount}`);

    if (outputPath) {
      await writeFile(outputPath, JSON.stringify({
        radio: { ip, port },
        capturedAt: new Date().toISOString(),
        frameTarget,
        timeoutMs,
        frames
      }, null, 2), 'utf8');
      console.log(`  output:   ${outputPath}`);
    }
  } finally {
    await cleanup();
  }
}

function logScopeFrame(stamp: string, frame: IcomScopeFrame, index: number) {
  const samplePixels = Array.from(frame.pixels.slice(0, Math.min(frame.pixels.length, 12)));
  console.log(
    stamp,
    `scope-frame #${index}`,
    `freq=${frame.startFreqHz}..${frame.endFreqHz}Hz`,
    `pixels=${frame.pixels.length}`,
    `mode=${frame.mode}`,
    `oor=${frame.outOfRange}`,
    `sample=[${samplePixels.join(', ')}]`
  );
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${label}`);
    }
    await sleep(100);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
