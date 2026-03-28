export const IcomScopeCommands = {
  setScopeDataOutput(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x11, enabled ? 0x01 : 0x00, 0xfd
    ]);
  },

  setScopeDisplay(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x10, enabled ? 0x01 : 0x00, 0xfd
    ]);
  },

  readScopeSpan(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x15, receiver & 0xff, 0xfd
    ]);
  },

  setScopeSpan(ctrAddr: number, rigAddr: number, spanHz: number, receiver: 0 | 1 = 0): Buffer {
    const bytes = IcomScopeCommands.encodeScopeSpanHz(spanHz);
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x15, receiver & 0xff, ...bytes, 0xfd
    ]);
  },

  encodeScopeSpanHz(spanHz: number): Buffer {
    const safeSpanHz = Math.max(0, Math.round(spanHz));
    const out = Buffer.alloc(5);
    let remaining = safeSpanHz;
    for (let i = 0; i < out.length; i++) {
      const twoDigits = remaining % 100;
      out[i] = ((((twoDigits / 10) | 0) & 0x0f) << 4) | (twoDigits % 10);
      remaining = Math.floor(remaining / 100);
    }
    return out;
  }
};
