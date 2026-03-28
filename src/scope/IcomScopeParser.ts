import { IcomScopeSegmentInfo } from '../types';

const SCOPE_PREFIX = [0x27, 0x00, 0x00] as const;

export function isScopeFrame(frame: Buffer): boolean {
  if (frame.length < 9) return false;
  if (frame[0] !== 0xfe || frame[1] !== 0xfe) return false;
  if (frame[frame.length - 1] !== 0xfd) return false;
  return frame[4] === SCOPE_PREFIX[0] && frame[5] === SCOPE_PREFIX[1] && frame[6] === SCOPE_PREFIX[2];
}

export function bcdByteToInt(v: number): number {
  return (v & 0x0f) + (((v >> 4) & 0x0f) * 10);
}

export function parseIcomBcdFreqLE(bytes: Buffer): number {
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

export function parseScopeSegment(
  frame: Buffer,
  transport: 'lan-civ' | 'serial',
  freqLen: number = 5
): IcomScopeSegmentInfo | null {
  if (!isScopeFrame(frame)) return null;

  const payload = frame.subarray(4, frame.length - 1);
  if (payload.length < 5) return null;

  const sequence = bcdByteToInt(payload[3]);
  const sequenceMax = bcdByteToInt(payload[4]);
  if (sequence <= 0 || sequenceMax <= 0 || sequence > sequenceMax) return null;

  const segment: IcomScopeSegmentInfo = {
    receiver: 0,
    sequence,
    sequenceMax,
    rawCivPayload: Buffer.from(payload),
    transport
  };

  if (sequence === 1) {
    const minimumHeaderLength = 3 + 2 + (freqLen * 2) + 1;
    if (payload.length < minimumHeaderLength) return null;

    const mode = payload[5] as 0 | 1 | 2 | 3;
    const primaryFreq = parseIcomBcdFreqLE(payload.subarray(6, 6 + freqLen));
    const secondaryFreq = parseIcomBcdFreqLE(payload.subarray(6 + freqLen, 6 + (freqLen * 2)));
    const outOfRange = payload[6 + (freqLen * 2)] !== 0x00;

    let startFreqHz = primaryFreq;
    let endFreqHz = secondaryFreq;
    if (mode === 0) {
      startFreqHz = Math.max(0, primaryFreq - secondaryFreq);
      endFreqHz = primaryFreq + secondaryFreq;
    }

    segment.mode = mode;
    segment.outOfRange = outOfRange;
    segment.startFreqHz = startFreqHz;
    segment.endFreqHz = endFreqHz;

    const pixelOffset = 7 + (freqLen * 2);
    segment.pixels = new Uint8Array(payload.subarray(pixelOffset));
    return segment;
  }

  segment.pixels = new Uint8Array(payload.subarray(5));
  return segment;
}
