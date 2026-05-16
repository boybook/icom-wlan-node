import { buildCivFrame, encodeFrequencyBcdLE } from '../rig/IcomCivFrame';
import { CIV } from '../rig/IcomCivSpec';

export const IcomScopeCommands = {
  setScopeDataOutput(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_DOP, payload: [enabled ? 0x01 : 0x00] });
  },

  setScopeDisplay(ctrAddr: number, rigAddr: number, enabled: boolean): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_STS, payload: [enabled ? 0x01 : 0x00] });
  },

  readScopeSpan(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_SPN, payload: [receiver & 0xff] });
  },

  setScopeSpan(ctrAddr: number, rigAddr: number, spanHz: number, receiver: 0 | 1 = 0): Buffer {
    // Hamlib maps public span to ICOM's +/- span value.
    const bytes = IcomScopeCommands.encodeScopeSpanHz(Math.round(spanHz / 2));
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_SPN, payload: [receiver & 0xff, ...bytes] });
  },

  readScopeMode(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_MOD, payload: [receiver & 0xff] });
  },

  setScopeMode(ctrAddr: number, rigAddr: number, mode: 0 | 1 | 2 | 3, receiver: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_MOD, payload: [receiver & 0xff, mode & 0xff] });
  },

  readScopeEdge(ctrAddr: number, rigAddr: number, receiver: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_EDG, payload: [receiver & 0xff] });
  },

  setScopeEdge(ctrAddr: number, rigAddr: number, edgeSlot: number, receiver: 0 | 1 = 0): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_EDG, payload: [receiver & 0xff, edgeSlot & 0xff] });
  },

  readScopeFixedEdge(ctrAddr: number, rigAddr: number, rangeId: number, edgeSlot: number): Buffer {
    return buildCivFrame({ rigAddr, ctrlAddr: ctrAddr, cmd: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_FEF, payload: [rangeId & 0xff, edgeSlot & 0xff] });
  },

  setScopeFixedEdge(
    ctrAddr: number,
    rigAddr: number,
    rangeId: number,
    edgeSlot: number,
    lowHz: number,
    highHz: number
  ): Buffer {
    return buildCivFrame({
      rigAddr,
      ctrlAddr: ctrAddr,
      cmd: CIV.C_CTL_SCP,
      subcmd: CIV.S_SCP_FEF,
      payload: [
        rangeId & 0xff,
        edgeSlot & 0xff,
        ...IcomScopeCommands.encodeScopeFreqHz(lowHz),
        ...IcomScopeCommands.encodeScopeFreqHz(highHz),
      ],
    });
  },

  encodeScopeSpanHz(spanHz: number): Buffer {
    return encodeFrequencyBcdLE(Math.max(0, Math.round(spanHz)), 5);
  },

  encodeScopeFreqHz(freqHz: number): Buffer {
    return encodeFrequencyBcdLE(Math.max(0, Math.round(freqHz)), 5);
  }
};
