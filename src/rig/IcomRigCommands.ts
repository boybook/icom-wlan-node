import { encodeBcdBE, encodeFrequencyBcdLE, buildCivFrame } from './IcomCivFrame';
import { CIV, ICOM_MODE_FILTER_DEFAULT } from './IcomCivSpec';

// Helpers to build standard CI-V frames for common rig operations.
export const IcomRigCommands = {
  setPTT(ctrAddr: number, rigAddr: number, on: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_PTT, payload: [on ? 0x01 : 0x00] });
  },

  readPTT(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_PTT });
  },

  setMode(ctrAddr: number, rigAddr: number, mode: number, filter: 1 | 2 | 3 = ICOM_MODE_FILTER_DEFAULT): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_MODE, subcmd: mode & 0xff, payload: [filter & 0xff] });
  },

  setSelectedMode(ctrAddr: number, rigAddr: number, mode: number, dataMode: boolean = false, filter: 1 | 2 | 3 = ICOM_MODE_FILTER_DEFAULT, vfoNumber: 0 | 1 = 0): Buffer {
    return buildCivFrame({
      rigAddr,
      ctrlAddr: ctrAddr,
      cmd: CIV.C_SEND_SEL_MODE,
      subcmd: vfoNumber,
      payload: [mode & 0xff, dataMode ? 0x01 : 0x00, filter & 0xff],
    });
  },

  setFrequency(ctrAddr: number, rigAddr: number, hz: number, bcdBytes: number = 5): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_FREQ, payload: encodeFrequencyBcdLE(hz, bcdBytes) });
  },

  setSelectedFrequency(ctrAddr: number, rigAddr: number, hz: number, bcdBytes: number = 5, vfoNumber: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SEND_SEL_FREQ, subcmd: vfoNumber, payload: encodeFrequencyBcdLE(hz, bcdBytes) });
  },

  readOperatingFrequency(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_FREQ });
  },

  readSelectedFrequency(ctrAddr: number, rigAddr: number, vfoNumber: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SEND_SEL_FREQ, subcmd: vfoNumber });
  },

  readOperatingMode(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_MODE });
  },

  readSelectedMode(ctrAddr: number, rigAddr: number, vfoNumber: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SEND_SEL_MODE, subcmd: vfoNumber });
  },

  readTransmitFrequency(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_RD_TX_FREQ });
  },

  readTransceiverState(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: [0x00, 0x48] });
  },

  readBandEdges(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_BAND });
  },

  setOperationDataMode(ctrAddr: number, rigAddr: number, mode: number, filter: 1 | 2 | 3 = ICOM_MODE_FILTER_DEFAULT): Buffer {
    return IcomRigCommands.setSelectedMode(ctrAddr, rigAddr, mode, true, filter, 0);
  },

  getSWRState(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_SWR });
  },
  getALCState(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_ALC });
  },
  getLevelMeter(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_SML });
  },
  getConnectorWLanLevel(ctrAddr: number, rigAddr: number, subext: number[] = [0x01, 0x17]): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: CIV.S_MEM_PARM, payload: subext });
  },
  setConnectorWLanLevel(ctrAddr: number, rigAddr: number, level: number, subext: number[] = [0x01, 0x17]): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: CIV.S_MEM_PARM, payload: [...subext, ...encodeBcdBE(level, 2)] });
  },
  setConnectorDataMode(ctrAddr: number, rigAddr: number, mode: number, subext: number[] = [0x01, 0x19]): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: CIV.S_MEM_PARM, payload: [...subext, mode & 0xff] });
  },
  getUsbAfLevel(ctrAddr: number, rigAddr: number, subext: number[] = [0x01, 0x13]): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: CIV.S_MEM_PARM, payload: subext });
  },
  setUsbAfLevel(ctrAddr: number, rigAddr: number, level: number, subext: number[] = [0x01, 0x13]): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_MEM, subcmd: CIV.S_MEM_PARM, payload: [...subext, ...encodeBcdBE(level, 2)] });
  },
  getSquelchStatus(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_SQL });
  },
  getAudioSquelch(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_CSQL });
  },
  getOvfStatus(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_OVF });
  },
  getPowerLevel(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_RFML });
  },
  getCompLevel(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_CMP });
  },
  getVoltage(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_VD });
  },
  getCurrent(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_RD_SQSM, subcmd: CIV.S_ID });
  },

  get0x14Level(ctrAddr: number, rigAddr: number, subcmd: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_LVL, subcmd });
  },

  set0x14Level(ctrAddr: number, rigAddr: number, subcmd: number, bcdHi: number, bcdLo: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_LVL, subcmd, payload: [bcdHi, bcdLo] });
  },

  readCommand(ctrAddr: number, rigAddr: number, cmd: number, subcmd?: number | number[], payload?: number[] | Buffer): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd, subcmd, payload });
  },

  writeCommand(ctrAddr: number, rigAddr: number, cmd: number, subcmd: number | number[] | undefined, payload?: number[] | Buffer): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd, subcmd, payload });
  },

  readFunction(ctrAddr: number, rigAddr: number, subcmd: number, payload?: number[] | Buffer): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_FUNC, subcmd, payload });
  },

  setFunction(ctrAddr: number, rigAddr: number, subcmd: number, value: number, payloadPrefix: number[] = []): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_FUNC, subcmd, payload: [...payloadPrefix, value & 0xff] });
  },

  readExtParam(ctrAddr: number, rigAddr: number, command: number, subcmd: number, subext: number[] = []): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: command, subcmd, payload: subext });
  },

  writeExtParam(ctrAddr: number, rigAddr: number, command: number, subcmd: number, subext: number[] = [], payload: number[] | Buffer = []): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: command, subcmd, payload: [...subext, ...Array.from(payload)] });
  },

  readRitOffset(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_RIT_FREQ });
  },

  setRitOffset(ctrAddr: number, rigAddr: number, payload: number[] | Buffer): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_RIT_FREQ, payload });
  },

  readRitEnabled(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_RIT });
  },

  setRitEnabled(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_RIT, payload: [enabled ? 1 : 0] });
  },

  readXitEnabled(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_XIT });
  },

  setXitEnabled(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_RIT, subcmd: CIV.S_XIT, payload: [enabled ? 1 : 0] });
  },

  readSplit(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SPLT });
  },

  setSplit(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SPLT, subcmd: enabled ? CIV.S_SPLT_ON : CIV.S_SPLT_OFF });
  },

  readTuningStep(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_TS });
  },

  setTuningStep(ctrAddr: number, rigAddr: number, code: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_TS, subcmd: code });
  },

  readRepeaterShift(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SPLT });
  },

  setRepeaterShift(ctrAddr: number, rigAddr: number, code: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SPLT, subcmd: code });
  },

  readTone(ctrAddr: number, rigAddr: number, subcmd: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_TONE, subcmd });
  },

  setTone(ctrAddr: number, rigAddr: number, subcmd: number, toneTenthHz: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_SET_TONE, subcmd, payload: encodeBcdBE(toneTenthHz, 3) });
  },

  getTunerStatus(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_ANT_TUN });
  },
  setTunerEnabled(ctrAddr: number, rigAddr: number, on: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_ANT_TUN, payload: [on ? 0x01 : 0x00] });
  },
  startManualTune(ctrAddr: number, rigAddr: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_PTT, subcmd: CIV.S_ANT_TUN, payload: [0x02] });
  }
};
