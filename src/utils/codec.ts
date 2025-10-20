// Byte order helpers for Icom packet formats
// Note: These now use CORRECT naming (be = Big-Endian, le = Little-Endian)

export const be16 = {
  read: (buf: Buffer, off: number) => buf.readUInt16BE(off), // Big-Endian: high byte first
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt16BE(v & 0xffff, off)
};

export const be32 = {
  read: (buf: Buffer, off: number) => buf.readUInt32BE(off), // Big-Endian: high byte first
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt32BE(v >>> 0, off)
};

export const le16 = {
  read: (buf: Buffer, off: number) => buf.readUInt16LE(off), // Little-Endian: low byte first
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt16LE(v & 0xffff, off)
};

export const le32 = {
  read: (buf: Buffer, off: number) => buf.readUInt32LE(off), // Little-Endian: low byte first
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt32LE(v >>> 0, off)
};

export function shortToBytesLE(n: number): Buffer {
  const b = Buffer.alloc(2);
  le16.write(b, 0, n);
  return b;
}

export function shortToBytesBE(n: number): Buffer {
  const b = Buffer.alloc(2);
  be16.write(b, 0, n);
  return b;
}

export function intToBytesLE(n: number): Buffer {
  const b = Buffer.alloc(4);
  le32.write(b, 0, n);
  return b;
}

export function intToBytesBE(n: number): Buffer {
  const b = Buffer.alloc(4);
  be32.write(b, 0, n);
  return b;
}

export function strToFixedBytes(str: string, len: number): Buffer {
  const out = Buffer.alloc(len, 0);
  const src = Buffer.from(str, 'utf8');
  src.copy(out, 0, 0, Math.min(len, src.length));
  return out;
}

export function hex(buf: Buffer): string {
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join(' ');
}

