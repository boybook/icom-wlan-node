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

  readScopeMode(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x14, receiver & 0xff, 0xfd
    ]);
  },

  setScopeMode(ctrAddr: number, rigAddr: number, mode: 0 | 1 | 2 | 3, receiver: 0 | 1 = 0): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x14, receiver & 0xff, mode & 0xff, 0xfd
    ]);
  },

  readScopeEdge(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x16, receiver & 0xff, 0xfd
    ]);
  },

  setScopeEdge(ctrAddr: number, rigAddr: number, edgeSlot: number, receiver: 0 | 1 = 0): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x16, receiver & 0xff, edgeSlot & 0xff, 0xfd
    ]);
  },

  readScopeFixedEdge(ctrAddr: number, rigAddr: number, rangeId: number, edgeSlot: number): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x1e, rangeId & 0xff, edgeSlot & 0xff, 0xfd
    ]);
  },

  setScopeFixedEdge(
    ctrAddr: number,
    rigAddr: number,
    rangeId: number,
    edgeSlot: number,
    lowHz: number,
    highHz: number
  ): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x27, 0x1e,
      rangeId & 0xff,
      edgeSlot & 0xff,
      ...IcomScopeCommands.encodeScopeFreqHz(lowHz),
      ...IcomScopeCommands.encodeScopeFreqHz(highHz),
      0xfd
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
  },

  encodeScopeFreqHz(freqHz: number): Buffer {
    const safeFreqHz = Math.max(0, Math.round(freqHz));
    const out = Buffer.alloc(5);
    let remaining = safeFreqHz;
    for (let i = 0; i < out.length; i++) {
      const twoDigits = remaining % 100;
      out[i] = ((((twoDigits / 10) | 0) & 0x0f) << 4) | (twoDigits % 10);
      remaining = Math.floor(remaining / 100);
    }
    return out;
  }
};
