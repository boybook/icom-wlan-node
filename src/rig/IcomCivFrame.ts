import { CIV } from './IcomCivSpec';

export interface CivFrameBuildOptions {
  rigAddr: number;
  ctrlAddr: number;
  cmd: number;
  subcmd?: number | number[];
  payload?: Buffer | number[];
}

export function buildCivFrame(options: CivFrameBuildOptions): Buffer {
  const subcmd = options.subcmd === undefined
    ? []
    : Array.isArray(options.subcmd)
      ? options.subcmd
      : [options.subcmd];
  const payload = options.payload ? Array.from(options.payload) : [];
  return Buffer.from([
    CIV.PR,
    CIV.PR,
    options.rigAddr & 0xff,
    options.ctrlAddr & 0xff,
    options.cmd & 0xff,
    ...subcmd.map((v) => v & 0xff),
    ...payload.map((v) => v & 0xff),
    CIV.FI,
  ]);
}

export function encodeFrequencyBcdLE(freqHz: number, byteLength: number = 5): Buffer {
  const out = Buffer.alloc(byteLength);
  let remaining = Math.max(0, Math.round(freqHz));
  for (let i = 0; i < byteLength; i++) {
    const twoDigits = remaining % 100;
    out[i] = ((((twoDigits / 10) | 0) & 0x0f) << 4) | (twoDigits % 10);
    remaining = Math.floor(remaining / 100);
  }
  return out;
}

export function decodeFrequencyBcdLE(bytes: Buffer | Uint8Array): number {
  let hz = 0;
  let multiplier = 1;
  for (const byte of bytes) {
    hz += (byte & 0x0f) * multiplier;
    multiplier *= 10;
    hz += ((byte >> 4) & 0x0f) * multiplier;
    multiplier *= 10;
  }
  return hz;
}

export function encodeBcdBE(value: number, byteLength: number): Buffer {
  const out = Buffer.alloc(byteLength);
  let remaining = Math.max(0, Math.floor(value));
  for (let i = byteLength - 1; i >= 0; i--) {
    const twoDigits = remaining % 100;
    out[i] = ((((twoDigits / 10) | 0) & 0x0f) << 4) | (twoDigits % 10);
    remaining = Math.floor(remaining / 100);
  }
  return out;
}

export function decodeBcdBE(bytes: Buffer | Uint8Array): number {
  let value = 0;
  for (const byte of bytes) {
    value = value * 100 + (((byte >> 4) & 0x0f) * 10) + (byte & 0x0f);
  }
  return value;
}

export function getCivPayload(frame: Buffer): Buffer | null {
  if (frame.length < 6) return null;
  if (frame[0] !== CIV.PR || frame[1] !== CIV.PR || frame[frame.length - 1] !== CIV.FI) return null;
  return frame.subarray(4, frame.length - 1);
}
