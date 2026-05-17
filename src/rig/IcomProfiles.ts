import type {
  IcomAudioIfSource,
  IcomFunctionName,
  IcomLevelName,
  IcomModelId,
  IcomParameterName,
  IcomVfoName,
  IcomVfoOperation,
} from '../types';

export interface CalibrationPoint {
  raw: number;
  value: number;
}

export interface IcomExtParam {
  command: number;
  subcmd: number;
  subext: number[];
  dataBytes: number;
  dataType: 'level' | 'bool' | 'int' | 'time';
}

export type IcomExtParamTable = Partial<Record<IcomFunctionName | IcomLevelName | IcomParameterName, IcomExtParam>>;

export interface IcomProfile {
  modelId: IcomModelId;
  profileName: string;
  defaultCivAddress: number;
  aliases: string[];
  supportsX25X26: boolean;
  supportsX1C03TxFreq: boolean;
  modeWithFilter: boolean;
  dataModeSupported: boolean;
  defaultFilter: 1 | 2 | 3;
  frequencyBcdBytes(freqHz: number): number;
  scopeLineLength?: number;
  scopeSingleFrameDataLength?: number;
  scopeEdgeSlots: number[];
  scopeRanges: Array<{ rangeId: number; lowHz: number; highHz: number }>;
  functions: IcomFunctionName[];
  levels: IcomLevelName[];
  parameters: IcomParameterName[];
  tuningSteps: Array<{ hz: number; code: number }>;
  vfoOps: IcomVfoOperation[];
  vfos: IcomVfoName[];
  repeater: boolean;
  tone: boolean;
  cw: {
    sendMorse: boolean;
    maxChunkLength: number;
  };
  spectrumAdvanced: Array<'dataOutput' | 'hold' | 'speed' | 'ref' | 'avg' | 'vbw' | 'rbw' | 'duringTx' | 'centerType'>;
  audioIfSources: IcomAudioIfSource[];
  calibrations: {
    sMeterModel: string;
    swr: CalibrationPoint[];
    alc: CalibrationPoint[];
    rfPowerWatts: CalibrationPoint[];
    compDb: CalibrationPoint[];
    voltage: CalibrationPoint[];
    current: CalibrationPoint[];
  };
  extParams: {
    usbAfLevel?: IcomExtParam;
    afIfWlan?: IcomExtParam;
  };
  extParamSpecs: IcomExtParamTable;
  vendorExtensions: {
    connectorWlanLevel?: IcomExtParam;
    connectorDataMode?: { command: number; subcmd: number; subext: number[] };
  };
}

const HF_SCOPE_RANGES_13 = [
  { rangeId: 1, lowHz: 30000, highHz: 1600000 },
  { rangeId: 2, lowHz: 1600000, highHz: 2000000 },
  { rangeId: 3, lowHz: 2000000, highHz: 6000000 },
  { rangeId: 4, lowHz: 6000000, highHz: 8000000 },
  { rangeId: 5, lowHz: 8000000, highHz: 11000000 },
  { rangeId: 6, lowHz: 11000000, highHz: 15000000 },
  { rangeId: 7, lowHz: 15000000, highHz: 20000000 },
  { rangeId: 8, lowHz: 20000000, highHz: 22000000 },
  { rangeId: 9, lowHz: 22000000, highHz: 26000000 },
  { rangeId: 10, lowHz: 26000000, highHz: 30000000 },
  { rangeId: 11, lowHz: 30000000, highHz: 45000000 },
  { rangeId: 12, lowHz: 45000000, highHz: 60000000 },
  { rangeId: 13, lowHz: 60000000, highHz: 74800000 },
];

const HF_VHF_UHF_SCOPE_RANGES_17 = [
  ...HF_SCOPE_RANGES_13,
  { rangeId: 14, lowHz: 74800000, highHz: 108000000 },
  { rangeId: 15, lowHz: 108000000, highHz: 137000000 },
  { rangeId: 16, lowHz: 137000000, highHz: 200000000 },
  { rangeId: 17, lowHz: 400000000, highHz: 470000000 },
];

const IC9700_SCOPE_RANGES = [
  { rangeId: 1, lowHz: 144000000, highHz: 148000000 },
  { rangeId: 2, lowHz: 430000000, highHz: 450000000 },
  { rangeId: 3, lowHz: 1240000000, highHz: 1300000000 },
];

const IC7610_SCOPE_RANGES = HF_SCOPE_RANGES_13.slice(0, 12);

const DEFAULT_SWR = [
  { raw: 0, value: 1.0 },
  { raw: 48, value: 1.5 },
  { raw: 80, value: 2.0 },
  { raw: 120, value: 3.0 },
  { raw: 240, value: 6.0 },
];

const DEFAULT_ALC = [
  { raw: 0, value: 0 },
  { raw: 120, value: 100 },
];

const IC7300_RF_POWER = [
  { raw: 0, value: 0 },
  { raw: 21, value: 5 },
  { raw: 43, value: 10 },
  { raw: 65, value: 15 },
  { raw: 83, value: 20 },
  { raw: 95, value: 25 },
  { raw: 105, value: 30 },
  { raw: 114, value: 35 },
  { raw: 124, value: 40 },
  { raw: 143, value: 50 },
  { raw: 183, value: 75 },
  { raw: 213, value: 100 },
  { raw: 255, value: 120 },
];

const IC705_RF_POWER = IC7300_RF_POWER.map((p) => ({ raw: p.raw, value: p.value / 10 }));

const DEFAULT_COMP = [
  { raw: 0, value: 0 },
  { raw: 130, value: 15 },
  { raw: 241, value: 30 },
];

const IC705_COMP = [
  { raw: 0, value: 0 },
  { raw: 11, value: 0 },
  { raw: 34, value: 3 },
  { raw: 58, value: 6 },
  { raw: 81, value: 9 },
  { raw: 104, value: 12 },
  { raw: 128, value: 15 },
  { raw: 151, value: 18 },
  { raw: 174, value: 21 },
  { raw: 197, value: 24 },
  { raw: 221, value: 27 },
  { raw: 244, value: 30 },
];

const DEFAULT_VOLTAGE = [
  { raw: 0, value: 0 },
  { raw: 13, value: 10 },
  { raw: 241, value: 16 },
];

const IC705_VOLTAGE = [
  { raw: 0, value: 0 },
  { raw: 241, value: 16 },
];

const DEFAULT_CURRENT = [
  { raw: 0, value: 0 },
  { raw: 97, value: 10 },
  { raw: 146, value: 15 },
  { raw: 241, value: 25 },
];

const IC705_CURRENT = [
  { raw: 0, value: 0 },
  { raw: 241, value: 4 },
];

const COMMON_FUNCTIONS: IcomFunctionName[] = [
  'NB', 'NR', 'COMP', 'VOX', 'TONE', 'TSQL', 'SBKIN', 'FBKIN',
  'MON', 'ANF', 'MN', 'LOCK', 'RIT', 'XIT', 'TUNER', 'SCOPE',
  'SPECTRUM', 'SPECTRUM_HOLD', 'TRANSCEIVE', 'OVF_STATUS',
];

const COMMON_LEVELS: IcomLevelName[] = [
  'AF', 'RF', 'SQL', 'IF', 'NR', 'NB', 'PBT_IN', 'PBT_OUT',
  'CWPITCH', 'RFPOWER', 'MICGAIN', 'KEYSPD', 'NOTCHF_RAW', 'COMP',
  'BKINDL', 'VOXGAIN', 'ANTIVOX', 'MONITOR_GAIN', 'AGC', 'AGC_TIME',
];

const COMMON_PARAMETERS: IcomParameterName[] = ['ANN', 'BEEP', 'BACKLIGHT', 'SCREENSAVER', 'TIME', 'KEYERTYPE', 'AFIF'];
const SAFE_FUNCTIONS: IcomFunctionName[] = ['NB', 'NR', 'COMP', 'VOX', 'MON', 'ANF', 'MN', 'LOCK', 'RIT', 'XIT', 'TUNER', 'SCOPE', 'SPECTRUM', 'SPECTRUM_HOLD', 'OVF_STATUS'];
const SAFE_LEVELS: IcomLevelName[] = ['AF', 'RF', 'SQL', 'NR', 'NB', 'RFPOWER', 'MICGAIN', 'COMP', 'BKINDL', 'MONITOR_GAIN'];
const DEFAULT_VFOS: IcomVfoName[] = ['A', 'B', 'CURR', 'TX'];
const TARGETABLE_VFOS: IcomVfoName[] = ['A', 'B', 'MAIN', 'SUB', 'MAIN_A', 'MAIN_B', 'SUB_A', 'SUB_B', 'MEM', 'CURR', 'TX'];
const COMMON_VFO_OPS: IcomVfoOperation[] = ['copy', 'exchange', 'from-vfo', 'to-vfo', 'memory-clear', 'tune'];
const IC905_VFO_OPS: IcomVfoOperation[] = ['copy', 'from-vfo', 'to-vfo', 'memory-clear', 'tune'];
const SPECTRUM_ADVANCED = ['dataOutput', 'hold', 'speed', 'ref', 'avg', 'vbw', 'rbw', 'duringTx', 'centerType'] as IcomProfile['spectrumAdvanced'];
const CW_TEXT_SUPPORTED = { sendMorse: true, maxChunkLength: 30 };

const TS_IC756PRO = [
  { hz: 10, code: 0x00 },
  { hz: 100, code: 0x01 },
  { hz: 1000, code: 0x02 },
  { hz: 5000, code: 0x03 },
  { hz: 9000, code: 0x04 },
  { hz: 10000, code: 0x05 },
  { hz: 12500, code: 0x06 },
  { hz: 20000, code: 0x07 },
  { hz: 25000, code: 0x08 },
];

const TS_IC7300 = [
  { hz: 1, code: 0x00 },
  ...TS_IC756PRO.slice(1),
];

const TS_IC705 = [
  { hz: 10, code: 0x00 },
  { hz: 100, code: 0x01 },
  { hz: 500, code: 0x02 },
  { hz: 1000, code: 0x03 },
  { hz: 5000, code: 0x04 },
  { hz: 6250, code: 0x05 },
  { hz: 8330, code: 0x06 },
  { hz: 9000, code: 0x07 },
  { hz: 10000, code: 0x08 },
  { hz: 12500, code: 0x09 },
  { hz: 20000, code: 0x10 },
  { hz: 25000, code: 0x11 },
  { hz: 50000, code: 0x12 },
  { hz: 100000, code: 0x13 },
];

const TS_IC9700 = [
  { hz: 10, code: 0x00 },
  { hz: 100, code: 0x01 },
  { hz: 500, code: 0x02 },
  { hz: 1000, code: 0x03 },
  { hz: 5000, code: 0x04 },
  { hz: 6250, code: 0x05 },
  { hz: 10000, code: 0x06 },
  { hz: 12500, code: 0x07 },
  { hz: 20000, code: 0x08 },
  { hz: 25000, code: 0x09 },
  { hz: 50000, code: 0x10 },
  { hz: 100000, code: 0x11 },
];

function baseProfile(overrides: Partial<IcomProfile> & Pick<IcomProfile, 'modelId' | 'profileName' | 'defaultCivAddress' | 'aliases'>): IcomProfile {
  return {
    supportsX25X26: true,
    supportsX1C03TxFreq: true,
    modeWithFilter: true,
    dataModeSupported: true,
    defaultFilter: 1,
    frequencyBcdBytes: () => 5,
    scopeLineLength: 475,
    scopeSingleFrameDataLength: 50,
    scopeEdgeSlots: [1, 2, 3, 4],
    scopeRanges: HF_SCOPE_RANGES_13,
    functions: SAFE_FUNCTIONS,
    levels: SAFE_LEVELS,
    parameters: [],
    tuningSteps: TS_IC705,
    vfoOps: COMMON_VFO_OPS,
    vfos: DEFAULT_VFOS,
    repeater: false,
    tone: false,
    cw: { sendMorse: false, maxChunkLength: 30 },
    spectrumAdvanced: ['dataOutput', 'hold', 'speed', 'ref', 'vbw', 'duringTx', 'centerType'],
    audioIfSources: ['default'],
    calibrations: {
      sMeterModel: 'IC-705',
      swr: DEFAULT_SWR,
      alc: DEFAULT_ALC,
      rfPowerWatts: IC7300_RF_POWER,
      compDb: DEFAULT_COMP,
      voltage: DEFAULT_VOLTAGE,
      current: DEFAULT_CURRENT,
    },
    extParams: {},
    extParamSpecs: {},
    vendorExtensions: {},
    ...overrides,
  };
}

const ic705Ext = {
  usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x13], dataBytes: 2, dataType: 'level' as const },
  afIfWlan: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x14], dataBytes: 1, dataType: 'bool' as const },
};

const ext = (subext: number[], dataBytes: number, dataType: IcomExtParam['dataType']): IcomExtParam => ({
  command: 0x1a,
  subcmd: 0x05,
  subext,
  dataBytes,
  dataType,
});

const IC7300_EXT_SPECS: IcomExtParamTable = {
  BEEP: ext([0x00, 0x23], 1, 'bool'),
  BACKLIGHT: ext([0x00, 0x81], 2, 'level'),
  SCREENSAVER: ext([0x00, 0x89], 1, 'int'),
  TIME: ext([0x00, 0x95], 2, 'time'),
  AFIF: ext([0x00, 0x59], 1, 'bool'),
  VOXDELAY: ext([0x01, 0x59], 1, 'int'),
  TRANSCEIVE: ext([0x00, 0x71], 1, 'bool'),
  SPECTRUM_AVG: ext([0x01, 0x02], 1, 'int'),
  AGC_TIME: { command: 0x1a, subcmd: 0x04, subext: [], dataBytes: 1, dataType: 'int' },
  KEYERTYPE: ext([0x01, 0x64], 1, 'int'),
};

const IC705_EXT_SPECS: IcomExtParamTable = {
  BEEP: ext([0x00, 0x31], 1, 'bool'),
  BACKLIGHT: ext([0x01, 0x36], 2, 'level'),
  SCREENSAVER: ext([0x01, 0x38], 1, 'int'),
  TIME: ext([0x01, 0x66], 2, 'time'),
  AFIF: ext([0x01, 0x09], 1, 'bool'),
  AFIF_WLAN: ext([0x01, 0x14], 1, 'bool'),
  VOXDELAY: ext([0x03, 0x59], 1, 'int'),
  TRANSCEIVE: ext([0x01, 0x31], 1, 'bool'),
  SPECTRUM_AVG: ext([0x01, 0x78], 1, 'int'),
  AGC_TIME: { command: 0x1a, subcmd: 0x04, subext: [], dataBytes: 1, dataType: 'int' },
  KEYERTYPE: ext([0x02, 0x55], 1, 'int'),
};

const IC9700_EXT_SPECS: IcomExtParamTable = {
  BEEP: ext([0x00, 0x29], 1, 'bool'),
  BACKLIGHT: ext([0x01, 0x52], 2, 'level'),
  SCREENSAVER: ext([0x01, 0x67], 1, 'int'),
  TIME: ext([0x01, 0x80], 2, 'time'),
  AFIF: ext([0x01, 0x05], 1, 'bool'),
  AFIF_ACC: ext([0x01, 0x00], 1, 'bool'),
  AFIF_LAN: ext([0x01, 0x10], 1, 'bool'),
  VOXDELAY: ext([0x03, 0x30], 1, 'int'),
  TRANSCEIVE: ext([0x01, 0x27], 1, 'bool'),
  SPECTRUM_AVG: ext([0x01, 0x92], 1, 'int'),
  AGC_TIME: { command: 0x1a, subcmd: 0x04, subext: [], dataBytes: 1, dataType: 'int' },
  KEYERTYPE: ext([0x02, 0x27], 1, 'int'),
};

const IC7610_EXT_SPECS: IcomExtParamTable = {
  BEEP: ext([0x00, 0x24], 1, 'bool'),
  BACKLIGHT: ext([0x01, 0x41], 2, 'level'),
  TIME: ext([0x01, 0x59], 2, 'time'),
  VOXDELAY: ext([0x02, 0x92], 1, 'int'),
  TRANSCEIVE: ext([0x01, 0x12], 1, 'bool'),
  SPECTRUM_AVG: ext([0x01, 0x70], 1, 'int'),
  AGC_TIME: { command: 0x1a, subcmd: 0x04, subext: [], dataBytes: 1, dataType: 'int' },
  KEYERTYPE: ext([0x02, 0x31], 1, 'int'),
};

const IC7760_EXT_SPECS: IcomExtParamTable = {
  VOXDELAY: ext([0x01, 0x82], 1, 'int'),
  AGC_TIME: { command: 0x1a, subcmd: 0x04, subext: [], dataBytes: 1, dataType: 'int' },
};

const ic705Vendor = {
  connectorWlanLevel: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x17], dataBytes: 2, dataType: 'level' as const },
  connectorDataMode: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x19] },
};

export const ICOM_PROFILES: Record<IcomModelId, IcomProfile> = {
  'generic-modern-icom': baseProfile({
    modelId: 'generic-modern-icom',
    profileName: 'Generic modern ICOM CI-V',
    defaultCivAddress: 0xa4,
    aliases: ['generic', 'icom'],
    scopeRanges: HF_VHF_UHF_SCOPE_RANGES_17,
    functions: SAFE_FUNCTIONS,
    levels: SAFE_LEVELS,
  }),
  'IC-705': baseProfile({
    modelId: 'IC-705',
    profileName: 'Icom IC-705',
    defaultCivAddress: 0xa4,
    aliases: ['IC-705', 'IC705'],
    scopeRanges: HF_VHF_UHF_SCOPE_RANGES_17,
    functions: COMMON_FUNCTIONS,
    levels: [...COMMON_LEVELS, 'SPECTRUM_AVG'],
    parameters: [...COMMON_PARAMETERS, 'AFIF_WLAN'],
    tuningSteps: TS_IC705,
    vfoOps: COMMON_VFO_OPS,
    vfos: DEFAULT_VFOS,
    repeater: true,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: ['dataOutput', 'hold', 'speed', 'ref', 'avg', 'vbw', 'duringTx', 'centerType'],
    audioIfSources: ['default', 'wlan'],
    calibrations: {
      sMeterModel: 'IC-705',
      swr: DEFAULT_SWR,
      alc: DEFAULT_ALC,
      rfPowerWatts: IC705_RF_POWER,
      compDb: IC705_COMP,
      voltage: IC705_VOLTAGE,
      current: IC705_CURRENT,
    },
    extParams: ic705Ext,
    extParamSpecs: IC705_EXT_SPECS,
    vendorExtensions: ic705Vendor,
  }),
  'IC-905': baseProfile({
    modelId: 'IC-905',
    profileName: 'Icom IC-905',
    defaultCivAddress: 0xac,
    aliases: ['IC-905', 'IC905'],
    frequencyBcdBytes: (freqHz) => freqHz > 5.85e9 ? 6 : 5,
    scopeRanges: HF_VHF_UHF_SCOPE_RANGES_17,
    functions: COMMON_FUNCTIONS,
    levels: [...COMMON_LEVELS, 'SPECTRUM_AVG'],
    parameters: [...COMMON_PARAMETERS, 'AFIF_WLAN'],
    tuningSteps: TS_IC705,
    vfoOps: IC905_VFO_OPS,
    vfos: DEFAULT_VFOS,
    repeater: true,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: ['dataOutput', 'hold', 'speed', 'ref', 'avg', 'vbw', 'duringTx', 'centerType'],
    audioIfSources: ['default', 'wlan'],
    calibrations: {
      sMeterModel: 'IC-705',
      swr: DEFAULT_SWR,
      alc: DEFAULT_ALC,
      rfPowerWatts: IC705_RF_POWER,
      compDb: DEFAULT_COMP,
      voltage: DEFAULT_VOLTAGE,
      current: DEFAULT_CURRENT,
    },
    extParams: ic705Ext,
    extParamSpecs: IC705_EXT_SPECS,
    vendorExtensions: ic705Vendor,
  }),
  'IC-7300': baseProfile({
    modelId: 'IC-7300',
    profileName: 'Icom IC-7300',
    defaultCivAddress: 0x94,
    aliases: ['IC-7300', 'IC7300'],
    scopeRanges: HF_SCOPE_RANGES_13,
    functions: COMMON_FUNCTIONS,
    levels: [...COMMON_LEVELS, 'DRIVE_GAIN', 'DIGI_SEL_LEVEL', 'SPECTRUM_AVG'],
    parameters: COMMON_PARAMETERS,
    tuningSteps: TS_IC7300,
    vfoOps: COMMON_VFO_OPS,
    vfos: DEFAULT_VFOS,
    repeater: false,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: ['dataOutput', 'hold', 'speed', 'ref', 'avg', 'vbw', 'duringTx', 'centerType'],
    audioIfSources: ['default'],
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x00, 0x60], dataBytes: 2, dataType: 'level' },
    },
    extParamSpecs: {
      ...IC7300_EXT_SPECS,
      DRIVE_GAIN: { command: 0x14, subcmd: 0x14, subext: [], dataBytes: 2, dataType: 'level' },
      DIGI_SEL: { command: 0x16, subcmd: 0x4e, subext: [], dataBytes: 1, dataType: 'bool' },
      DIGI_SEL_LEVEL: { command: 0x14, subcmd: 0x13, subext: [], dataBytes: 2, dataType: 'level' },
    },
  }),
  'IC-9700': baseProfile({
    modelId: 'IC-9700',
    profileName: 'Icom IC-9700',
    defaultCivAddress: 0xa2,
    aliases: ['IC-9700', 'IC9700'],
    scopeRanges: IC9700_SCOPE_RANGES,
    functions: [...COMMON_FUNCTIONS, 'SATMODE', 'DUAL_WATCH', 'AFC'],
    levels: [...COMMON_LEVELS, 'SPECTRUM_AVG'],
    parameters: [...COMMON_PARAMETERS, 'AFIF_LAN', 'AFIF_ACC'],
    tuningSteps: TS_IC9700,
    vfoOps: ['copy', 'exchange', 'from-vfo', 'to-vfo', 'memory-clear'],
    vfos: TARGETABLE_VFOS,
    repeater: true,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: ['dataOutput', 'hold', 'speed', 'ref', 'avg', 'vbw', 'duringTx', 'centerType'],
    audioIfSources: ['default', 'lan', 'acc'],
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x06], dataBytes: 2, dataType: 'level' },
    },
    extParamSpecs: IC9700_EXT_SPECS,
  }),
  'IC-7610': baseProfile({
    modelId: 'IC-7610',
    profileName: 'Icom IC-7610',
    defaultCivAddress: 0x98,
    aliases: ['IC-7610', 'IC7610'],
    scopeLineLength: 689,
    scopeRanges: IC7610_SCOPE_RANGES,
    functions: [...COMMON_FUNCTIONS, 'APF', 'DUAL_WATCH', 'DIGI_SEL', 'IPP', 'TX_INHIBIT', 'DPP', 'ICPW2'],
    levels: [...COMMON_LEVELS, 'APF', 'BALANCE', 'DRIVE_GAIN', 'DIGI_SEL_LEVEL', 'SPECTRUM_AVG'],
    parameters: ['BEEP', 'BACKLIGHT', 'TIME', 'KEYERTYPE'],
    tuningSteps: TS_IC756PRO,
    vfoOps: COMMON_VFO_OPS,
    vfos: TARGETABLE_VFOS,
    repeater: false,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: SPECTRUM_ADVANCED,
    audioIfSources: ['default'],
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x00, 0x82], dataBytes: 2, dataType: 'level' },
    },
    extParamSpecs: {
      ...IC7610_EXT_SPECS,
      DRIVE_GAIN: { command: 0x14, subcmd: 0x14, subext: [], dataBytes: 2, dataType: 'level' },
      DIGI_SEL: { command: 0x16, subcmd: 0x4e, subext: [], dataBytes: 1, dataType: 'bool' },
      DIGI_SEL_LEVEL: { command: 0x14, subcmd: 0x13, subext: [], dataBytes: 2, dataType: 'level' },
      IPP: { command: 0x16, subcmd: 0x65, subext: [], dataBytes: 1, dataType: 'bool' },
      TX_INHIBIT: { command: 0x16, subcmd: 0x66, subext: [], dataBytes: 1, dataType: 'bool' },
      DPP: { command: 0x16, subcmd: 0x67, subext: [], dataBytes: 1, dataType: 'bool' },
      ICPW2: ext([0x03, 0x10], 1, 'bool'),
    },
  }),
  'IC-7760': baseProfile({
    modelId: 'IC-7760',
    profileName: 'Icom IC-7760',
    defaultCivAddress: 0xb2,
    aliases: ['IC-7760', 'IC7760'],
    scopeRanges: HF_SCOPE_RANGES_13,
    functions: ['NB', 'NR', 'COMP', 'VOX', 'TONE', 'TSQL', 'SBKIN', 'FBKIN', 'MON', 'ANF', 'MN', 'VSC', 'LOCK', 'RIT', 'XIT', 'TUNER', 'APF', 'DIGI_SEL'],
    levels: [...COMMON_LEVELS, 'APF', 'BALANCE', 'DRIVE_GAIN', 'DIGI_SEL_LEVEL'],
    parameters: ['ANN', 'BACKLIGHT'],
    tuningSteps: TS_IC756PRO,
    vfoOps: COMMON_VFO_OPS,
    vfos: DEFAULT_VFOS,
    repeater: false,
    tone: true,
    cw: CW_TEXT_SUPPORTED,
    spectrumAdvanced: [],
    extParamSpecs: {
      ...IC7760_EXT_SPECS,
      DRIVE_GAIN: { command: 0x14, subcmd: 0x14, subext: [], dataBytes: 2, dataType: 'level' },
      DIGI_SEL: { command: 0x16, subcmd: 0x4e, subext: [], dataBytes: 1, dataType: 'bool' },
      DIGI_SEL_LEVEL: { command: 0x14, subcmd: 0x13, subext: [], dataBytes: 2, dataType: 'level' },
    },
  }),
};

export function interpolateCalibration(raw: number, points: CalibrationPoint[]): number {
  if (points.length === 0) return raw;
  const sorted = [...points].sort((a, b) => a.raw - b.raw);
  if (raw <= sorted[0].raw) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    const left = sorted[i - 1];
    const right = sorted[i];
    if (raw <= right.raw) {
      const ratio = (raw - left.raw) / (right.raw - left.raw);
      return left.value + (right.value - left.value) * ratio;
    }
  }
  return sorted[sorted.length - 1].value;
}

export function getProfileByModel(model?: IcomModelId | 'auto'): IcomProfile {
  if (model && model !== 'auto') return ICOM_PROFILES[model] ?? ICOM_PROFILES['generic-modern-icom'];
  return ICOM_PROFILES['generic-modern-icom'];
}

export function resolveIcomProfile(options: { requestedModel?: IcomModelId | 'auto'; rigName?: string; civAddress?: number }): IcomProfile {
  if (options.requestedModel && options.requestedModel !== 'auto') {
    return getProfileByModel(options.requestedModel);
  }

  const normalizedName = options.rigName?.replace(/\s+/g, '').toUpperCase();
  if (normalizedName) {
    const byName = Object.values(ICOM_PROFILES).find((profile) =>
      profile.aliases.some((alias) => normalizedName.includes(alias.replace(/\s+/g, '').toUpperCase()))
    );
    if (byName) return byName;
  }

  if (options.civAddress !== undefined) {
    const byAddress = Object.values(ICOM_PROFILES).find((profile) => profile.defaultCivAddress === (options.civAddress! & 0xff));
    if (byAddress) return byAddress;
  }

  return ICOM_PROFILES['generic-modern-icom'];
}
