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
  }
};
