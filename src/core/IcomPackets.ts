import { intToBytesBE, shortToBytesBE, strToFixedBytes, be16, be32, le16, le32 } from '../utils/codec';
import { dbg } from '../utils/debug';

// Constants derived from Android implementation and known Icom behavior
export const Sizes = {
  CONTROL: 0x10,
  WATCHDOG: 0x14,
  PING: 0x15,
  OPENCLOSE: 0x16,
  RETRANSMIT_RANGE: 0x18,
  TOKEN: 0x40,
  STATUS: 0x50,
  LOGIN_RESPONSE: 0x60,
  LOGIN: 0x80,
  CONNINFO: 0x90,
  CAP: 0x42,
  RADIO_CAP: 0x66,
  CAP_CAP: 0xA8,
  AUDIO_HEAD: 0x18
} as const;

export const Cmd = {
  NULL: 0x00,
  RETRANSMIT: 0x01,
  ARE_YOU_THERE: 0x03,
  I_AM_HERE: 0x04,
  DISCONNECT: 0x05,
  ARE_YOU_READY: 0x06,
  I_AM_READY: 0x06,
  PING: 0x07
} as const;

export const TokenType = {
  DELETE: 0x01,
  CONFIRM: 0x02,
  DISCONNECT: 0x04,
  RENEWAL: 0x05
} as const;

export const AUDIO_SAMPLE_RATE = 12000;
export const TX_BUFFER_SIZE = 0xf0; // 240 samples (20ms @ 12k), 16-bit => 480 bytes
export const XIEGU_TX_BUFFER_SIZE = 0x96; // for compatibility with some clients

// Control packet (0x10)
export const ControlPacket = {
  toBytes(type: number, seq: number, sentId: number, rcvdId: number): Buffer {
    const buf = Buffer.alloc(Sizes.CONTROL);
    le32.write(buf, 0, Sizes.CONTROL);
    le16.write(buf, 4, type);
    le16.write(buf, 6, seq);
    le32.write(buf, 8, sentId);
    le32.write(buf, 12, rcvdId);
    return buf;
  },
  getType(buf: Buffer): number { return le16.read(buf, 4); },
  getSeq(buf: Buffer): number { return le16.read(buf, 6); },
  getSentId(buf: Buffer): number { return le32.read(buf, 8); },
  getRcvdId(buf: Buffer): number { return le32.read(buf, 12); },
  setSeq(buf: Buffer, seq: number) { le16.write(buf, 6, seq); }
};

// Ping (0x15)
export const PingPacket = {
  isPing(buf: Buffer): boolean { return ControlPacket.getType(buf) === Cmd.PING; },
  getReply(buf: Buffer): number { return buf[0x10]; },
  buildPing(localId: number, remoteId: number, seq: number): Buffer {
    const b = Buffer.alloc(Sizes.PING);
    le32.write(b, 0, Sizes.PING);
    le16.write(b, 4, Cmd.PING);
    le16.write(b, 6, seq);
    le32.write(b, 8, localId);
    le32.write(b, 12, remoteId);
    b[0x10] = 0x00;
    le32.write(b, 0x11, (Date.now() & 0xffffffff) >>> 0);
    return b;
  },
  buildReply(from: Buffer, localId: number, remoteId: number): Buffer {
    const b = Buffer.alloc(Sizes.PING);
    le32.write(b, 0, Sizes.PING);
    le16.write(b, 4, Cmd.PING);
    b[0x6] = from[0x6];
    b[0x7] = from[0x7];
    le32.write(b, 8, localId);
    le32.write(b, 12, remoteId);
    b[0x10] = 0x01;
    b[0x11] = from[0x11];
    b[0x12] = from[0x12];
    b[0x13] = from[0x13];
    b[0x14] = from[0x14];
    return b;
  }
};

// Token (0x40)
export const TokenPacket = {
  build(seq: number, localId: number, remoteId: number, requestType: number,
        innerSeq: number, tokRequest: number, token: number): Buffer {
    const b = Buffer.alloc(Sizes.TOKEN);
    le32.write(b, 0, Sizes.TOKEN);
    le16.write(b, 6, seq);
    le32.write(b, 8, localId);
    le32.write(b, 12, remoteId);
    // payloadSize, innerSeq, tokRequest, token are big-endian
    be16.write(b, 0x12, Sizes.TOKEN - 0x10);
    b[0x14] = 0x01; // requestReply
    b[0x15] = requestType;
    be16.write(b, 0x16, innerSeq);
    be16.write(b, 0x1a, tokRequest);
    be32.write(b, 0x1c, token);
    return b;
  },
  getRequestType(b: Buffer): number { return b[0x15]; },
  getRequestReply(b: Buffer): number { return b[0x14]; },
  getResponse(b: Buffer): number { return be32.read(b, 0x30); },
  getTokRequest(b: Buffer): number { return be16.read(b, 0x1a); },
  getToken(b: Buffer): number { return be32.read(b, 0x1c); }
};

// Login (0x80)
export const LoginPacket = {
  passCode(input: string): Buffer {
    const sequence = Buffer.from([
      ...new Array(32).fill(0),
      0x47, 0x5d, 0x4c, 0x42, 0x66, 0x20, 0x23, 0x46, 0x4e, 0x57, 0x45, 0x3d, 0x67, 0x76, 0x60, 0x41, 0x62, 0x39, 0x59, 0x2d, 0x68, 0x7e,
      0x7c, 0x65, 0x7d, 0x49, 0x29, 0x72, 0x73, 0x78, 0x21, 0x6e, 0x5a, 0x5e, 0x4a, 0x3e, 0x71, 0x2c, 0x2a, 0x54, 0x3c, 0x3a, 0x63, 0x4f,
      0x43, 0x75, 0x27, 0x79, 0x5b, 0x35, 0x70, 0x48, 0x6b, 0x56, 0x6f, 0x34, 0x32, 0x6c, 0x30, 0x61, 0x6d, 0x7b, 0x2f, 0x4b, 0x64, 0x38,
      0x2b, 0x2e, 0x50, 0x40, 0x3f, 0x55, 0x33, 0x37, 0x25, 0x77, 0x24, 0x26, 0x74, 0x6a, 0x28, 0x53, 0x4d, 0x69, 0x22, 0x5c, 0x44, 0x31,
      0x36, 0x58, 0x3b, 0x7a, 0x51, 0x5f, 0x52,
      ...new Array(29).fill(0)
    ]);
    const pass = Buffer.from(input, 'utf8');
    const out = Buffer.alloc(16, 0);
    for (let i = 0; i < pass.length && i < 16; i++) {
      let p = (pass[i] + i) & 0xff;
      if (p > 126) p = 32 + (p % 127);
      out[i] = sequence[p];
    }
    return out;
  },
  build(seq: number, localId: number, remoteId: number, innerSeq: number,
        tokRequest: number, token: number, userName: string, password: string, name: string): Buffer {
    const b = Buffer.alloc(Sizes.LOGIN);
    le32.write(b, 0, Sizes.LOGIN);
    le16.write(b, 4, 0);
    le16.write(b, 6, seq);
    le32.write(b, 8, localId);
    le32.write(b, 12, remoteId);
    // payloadSize, innerSeq, tokRequest, token are big-endian
    be16.write(b, 0x12, Sizes.LOGIN - 0x10);
    b[0x14] = 0x01; b[0x15] = 0x00;
    be16.write(b, 0x16, innerSeq);
    be16.write(b, 0x1a, tokRequest);
    be32.write(b, 0x1c, token);
    LoginPacket.passCode(userName).copy(b, 0x40);
    LoginPacket.passCode(password).copy(b, 0x50);
    strToFixedBytes(name, 16).copy(b, 0x60);
    return b;
  }
};

export const LoginResponsePacket = {
  // error and token are big-endian per FT8CN
  authOK(b: Buffer): boolean { return be32.read(b, 0x30) === 0; },
  errorNum(b: Buffer): number { return be32.read(b, 0x30); },
  getToken(b: Buffer): number { return be32.read(b, 0x1c); },
  getConnection(b: Buffer): string { return Buffer.from(b.subarray(0x40, 0x50)).toString('utf8').replace(/\0+$/, '').trim(); }
};

// Status (0x50)
export const StatusPacket = {
  // error at 0x30 is LE (Java uses readIntBigEndianData which is actually LE)
  authOK(b: Buffer): boolean { return le32.read(b, 0x30) === 0; },
  // disc at 0x40 equals 0 when connected
  getIsConnected(b: Buffer): boolean { return b[0x40] === 0x00; },
  // civ/audio ports are 16-bit big-endian at 0x42/0x46
  getRigCivPort(b: Buffer): number { return be16.read(b, 0x42); },
  getRigAudioPort(b: Buffer): number { return be16.read(b, 0x46); }
};

// Capabilities (0xA8) => RadioCap (0x66)
export const CapCapabilitiesPacket = {
  getRadioCapPacket(b: Buffer, idx: number): Buffer | null {
    const start = Sizes.CAP + Sizes.RADIO_CAP * idx;
    if (b.length < start + Sizes.RADIO_CAP) return null;
    return Buffer.from(b.subarray(start, start + Sizes.RADIO_CAP));
  }
};

export const RadioCapPacket = {
  getRigName(b: Buffer): string { return Buffer.from(b.subarray(0x10, 0x10 + 32)).toString('utf8').replace(/\0+$/, '').trim(); },
  getAudioName(b: Buffer): string { return Buffer.from(b.subarray(0x30, 0x30 + 32)).toString('utf8').replace(/\0+$/, '').trim(); },
  getCivAddress(b: Buffer): number { return b[0x52]; },
  getRxSupportSample(b: Buffer): number { return be16.read(b, 0x53); },
  getTxSupportSample(b: Buffer): number { return be16.read(b, 0x55); },
  getSupportTX(b: Buffer): boolean { return b[0x57] === 0x01; }
};

// Civ (reply=0xC1)
export const CivPacket = {
  isCiv(b: Buffer): boolean {
    if (b.length <= 0x15) return false;
    const len = le16.read(b, 0x11);
    const type = ControlPacket.getType(b);
    const expectedLen = b.length - 0x15;
    const isValid = (expectedLen === len) && (b[0x10] === 0xc1) && (type !== Cmd.RETRANSMIT);

    // Diagnostic logging
    if (!isValid) {
      dbg(`CivPacket.isCiv FAIL: bufLen=${b.length} civLen@0x11=${len} expected=${expectedLen} [0x10]=${b[0x10].toString(16)} type=${type.toString(16)}`);
    }

    return isValid;
  },
  getCivData(b: Buffer): Buffer { return Buffer.from(b.subarray(0x15)); },
  setCivData(seq: number, sentId: number, rcvdId: number, civSeq: number, data: Buffer): Buffer {
    const b = Buffer.alloc(0x15 + data.length);
    le32.write(b, 0, b.length);
    le16.write(b, 0x06, seq);
    le32.write(b, 0x08, sentId);
    le32.write(b, 0x0c, rcvdId);
    b[0x10] = 0xc1;
    // civ_len is little-endian
    le16.write(b, 0x11, data.length);
    // civSeq is big-endian (manual write)
    b[0x13] = (civSeq >> 8) & 0xff; b[0x14] = civSeq & 0xff;
    data.copy(b, 0x15);
    return b;
  }
};

// Open/Close (reply=0xC0)
export const OpenClosePacket = {
  toBytes(seq: number, sentId: number, rcvdId: number, civSeq: number, magic: number): Buffer {
    const b = Buffer.alloc(Sizes.OPENCLOSE);
    le32.write(b, 0, Sizes.OPENCLOSE);
    le16.write(b, 0x06, seq);
    le32.write(b, 0x08, sentId);
    le32.write(b, 0x0c, rcvdId);
    b[0x10] = 0xc0;
    // civ_len is little-endian (value 0x0001)
    le16.write(b, 0x11, 0x0001);
    // civSeq is big-endian (manual write)
    b[0x13] = (civSeq >> 8) & 0xff; b[0x14] = civSeq & 0xff;
    b[0x15] = magic & 0xff;
    return b;
  }
};

// ConnInfo (0x90): connection info exchange / request
export const ConnInfoPacket = {
  getBusy(b: Buffer): boolean { return b[0x60] !== 0x00; },
  getMacAddress(b: Buffer): Buffer { return Buffer.from(b.subarray(0x2a, 0x2a + 6)); },
  getRigName(b: Buffer): string { return Buffer.from(b.subarray(0x40, 0x40 + 32)).toString('utf8').replace(/\0+$/, '').trim(); },
  connectRequestPacket(seq: number, localSID: number, remoteSID: number,
    requestReply: number, requestType: number, innerSeq: number, tokRequest: number, token: number,
    macAddress: Buffer, rigName: string, userName: string, sampleRate: number,
    civPort: number, audioPort: number, txBufferSize: number): Buffer {
    const b = Buffer.alloc(Sizes.CONNINFO);
    le32.write(b, 0, Sizes.CONNINFO);
    le16.write(b, 4, 0);
    le16.write(b, 6, seq);
    le32.write(b, 8, localSID);
    le32.write(b, 12, remoteSID);
    // payloadsize, innerSeq, tokRequest, token are big-endian
    be16.write(b, 0x12, Sizes.CONNINFO - 0x10);
    b[0x14] = requestReply; b[0x15] = requestType;
    be16.write(b, 0x16, innerSeq);
    be16.write(b, 0x1a, tokRequest);
    be32.write(b, 0x1c, token);
    // commoncap 0x1080 and macaddress
    b[0x26] = 0x10; b[0x27] = 0x80;
    macAddress.copy(b, 0x28, 0, 6);
    strToFixedBytes(rigName, 32).copy(b, 0x40);
    LoginPacket.passCode(userName).copy(b, 0x60);
    b[0x70] = 0x01; b[0x71] = 0x01; // rx/tx enable
    b[0x72] = 0x04; b[0x73] = 0x04; // LPCM 1ch 16bit
    be32.write(b, 0x74, sampleRate);
    be32.write(b, 0x78, sampleRate);
    be32.write(b, 0x7c, civPort);
    be32.write(b, 0x80, audioPort);
    be32.write(b, 0x84, txBufferSize);
    b[0x88] = 0x01;
    return b;
  },
  connInfoPacketData(rigData: Buffer, seq: number, localSID: number, remoteSID: number,
    requestReply: number, requestType: number, innerSeq: number, tokRequest: number, token: number,
    rigName: string, userName: string, rxSampleRate: number, txSampleRate: number,
    civPort: number, audioPort: number, txBufferSize: number): Buffer {
    const b = Buffer.alloc(Sizes.CONNINFO);
    le32.write(b, 0, Sizes.CONNINFO);
    le16.write(b, 4, 0);
    le16.write(b, 6, seq);
    le32.write(b, 8, localSID);
    le32.write(b, 12, remoteSID);
    be16.write(b, 0x12, Sizes.CONNINFO - 0x10);
    b[0x14] = requestReply; b[0x15] = requestType;
    be16.write(b, 0x16, innerSeq);
    be16.write(b, 0x1a, tokRequest);
    be32.write(b, 0x1c, token);
    // copy device fields from rig packet
    rigData.subarray(32, 64).copy(b, 32);
    strToFixedBytes(rigName, 32).copy(b, 0x40);
    LoginPacket.passCode(userName).copy(b, 0x60);
    b[0x70] = 0x01; b[0x71] = 0x01;
    b[0x72] = 0x04; b[0x73] = 0x04;
    be32.write(b, 0x74, rxSampleRate);
    be32.write(b, 0x78, txSampleRate);
    be32.write(b, 0x7c, civPort);
    be32.write(b, 0x80, audioPort);
    be32.write(b, 0x84, txBufferSize);
    b[0x88] = 0x01;
    return b;
  }
};

// Audio
export const AudioPacket = {
  isAudioPacket(b: Buffer): boolean {
    if (b.length < Sizes.AUDIO_HEAD) return false;
    // datalen is big-endian
    return b.length - Sizes.AUDIO_HEAD === be16.read(b, 0x16);
  },
  getAudioData(b: Buffer): Buffer { return Buffer.from(b.subarray(0x18)); },
  getTxAudioPacket(audio: Buffer, seq: number, sentId: number, rcvdId: number, sendSeq: number): Buffer {
    const b = Buffer.alloc(Sizes.AUDIO_HEAD + audio.length);
    le32.write(b, 0, b.length);
    le16.write(b, 0x06, seq);
    le32.write(b, 0x08, sentId);
    le32.write(b, 0x0c, rcvdId);
    const ident = (audio.length === 0xa0) ? 0x8197 : 0x8000;
    // ident is big-endian (manual write)
    b[0x10] = (ident >> 8) & 0xff; b[0x11] = ident & 0xff;
    // sendseq is big-endian (manual write)
    b[0x12] = (sendSeq >> 8) & 0xff; b[0x13] = sendSeq & 0xff;
    // datalen is big-endian
    be16.write(b, 0x16, audio.length);
    audio.copy(b, 0x18);
    return b;
  }
};
