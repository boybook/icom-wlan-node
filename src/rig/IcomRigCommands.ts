// Helpers to build CI-V frames for common operations (PTT, mode, frequency)

export const IcomRigCommands = {
  // FE FE [rigAddr] [ctrAddr] 1C 00 [01|00] FD
  setPTT(ctrAddr: number, rigAddr: number, on: boolean): Buffer {
    return Buffer.from([
      0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1c, 0x00, on ? 0x01 : 0x00, 0xfd
    ]);
  },
  setMode(ctrAddr: number, rigAddr: number, mode: number): Buffer {
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x06, mode & 0xff, 0x01, 0xfd]);
  },
  setFrequency(ctrAddr: number, rigAddr: number, hz: number): Buffer {
    // 05: BCD format, little-endian nibbles per Java logic
    const bcd = (n: number) => (((n / 10) | 0) << 4) + (n % 10);
    const d0 = bcd(Math.floor(hz % 100));
    const d1 = bcd(Math.floor((hz % 10000) / 100));
    const d2 = bcd(Math.floor((hz % 1000000) / 10000));
    const d3 = bcd(Math.floor((hz % 100000000) / 1000000));
    const d4 = bcd(Math.floor(hz / 100000000));  // Fixed: was /1000000000
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x05, d0, d1, d2, d3, d4, 0xfd]);
  }
  ,
  readOperatingFrequency(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rigAddr] [ctrAddr] 0x03 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x03, 0xfd]);
  },
  readOperatingMode(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x04 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x04, 0xfd]);
  },
  readTransmitFrequency(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x1C 0x03 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1c, 0x03, 0xfd]);
  },
  readTransceiverState(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x1A 0x00 0x48 FD (not recommended by Java, but available)
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1a, 0x00, 0x48, 0xfd]);
  },
  readBandEdges(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x02 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x02, 0xfd]);
  },
  setOperationDataMode(ctrAddr: number, rigAddr: number, mode: number): Buffer {
    // FE FE [rig] [ctr] 0x26 0x00 [mode] 0x01 0x01 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x26, 0x00, mode & 0xff, 0x01, 0x01, 0xfd]);
  },
  getSWRState(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x12 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x12, 0xfd]);
  },
  getALCState(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x13 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x13, 0xfd]);
  },
  getLevelMeter(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x02 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x02, 0xfd]);
  },
  getConnectorWLanLevel(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x1A 0x05 0x01 0x17 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1a, 0x05, 0x01, 0x17, 0xfd]);
  },
  setConnectorWLanLevel(ctrAddr: number, rigAddr: number, level: number): Buffer {
    // FE FE [rig] [ctr] 0x1A 0x05 0x01 0x17 [level_hi] [level_lo] FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1a, 0x05, 0x01, 0x17, (level >> 8) & 0xff, level & 0xff, 0xfd]);
  },
  setConnectorDataMode(ctrAddr: number, rigAddr: number, mode: number): Buffer {
    // FE FE [rig] [ctr] 0x1A 0x05 0x01 0x19 [mode] FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x1a, 0x05, 0x01, 0x19, mode & 0xff, 0xfd]);
  },
  getSquelchStatus(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x01 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x01, 0xfd]);
  },
  getAudioSquelch(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x05 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x05, 0xfd]);
  },
  getOvfStatus(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x07 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x07, 0xfd]);
  },
  getPowerLevel(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x11 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x11, 0xfd]);
  },
  getCompLevel(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x14 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x14, 0xfd]);
  },
  getVoltage(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x15 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x15, 0xfd]);
  },
  getCurrent(ctrAddr: number, rigAddr: number): Buffer {
    // FE FE [rig] [ctr] 0x15 0x16 FD
    return Buffer.from([0xfe, 0xfe, rigAddr & 0xff, ctrAddr & 0xff, 0x15, 0x16, 0xfd]);
  }
};
