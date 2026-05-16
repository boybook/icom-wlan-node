import type { IcomModelId } from '../types';

export interface CalibrationPoint {
  raw: number;
  value: number;
}

export interface IcomExtParam {
  command: number;
  subcmd: number;
  subext: number[];
  dataBytes: number;
  dataType: 'level' | 'bool' | 'int';
}

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
    vendorExtensions: {},
    ...overrides,
  };
}

const ic705Ext = {
  usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x13], dataBytes: 2, dataType: 'level' as const },
  afIfWlan: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x14], dataBytes: 1, dataType: 'bool' as const },
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
  }),
  'IC-705': baseProfile({
    modelId: 'IC-705',
    profileName: 'Icom IC-705',
    defaultCivAddress: 0xa4,
    aliases: ['IC-705', 'IC705'],
    scopeRanges: HF_VHF_UHF_SCOPE_RANGES_17,
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
    vendorExtensions: ic705Vendor,
  }),
  'IC-905': baseProfile({
    modelId: 'IC-905',
    profileName: 'Icom IC-905',
    defaultCivAddress: 0xac,
    aliases: ['IC-905', 'IC905'],
    frequencyBcdBytes: (freqHz) => freqHz > 5.85e9 ? 6 : 5,
    scopeRanges: HF_VHF_UHF_SCOPE_RANGES_17,
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
    vendorExtensions: ic705Vendor,
  }),
  'IC-7300': baseProfile({
    modelId: 'IC-7300',
    profileName: 'Icom IC-7300',
    defaultCivAddress: 0x94,
    aliases: ['IC-7300', 'IC7300'],
    scopeRanges: HF_SCOPE_RANGES_13,
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x00, 0x60], dataBytes: 2, dataType: 'level' },
    },
  }),
  'IC-9700': baseProfile({
    modelId: 'IC-9700',
    profileName: 'Icom IC-9700',
    defaultCivAddress: 0xa2,
    aliases: ['IC-9700', 'IC9700'],
    scopeRanges: IC9700_SCOPE_RANGES,
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x01, 0x06], dataBytes: 2, dataType: 'level' },
    },
  }),
  'IC-7610': baseProfile({
    modelId: 'IC-7610',
    profileName: 'Icom IC-7610',
    defaultCivAddress: 0x98,
    aliases: ['IC-7610', 'IC7610'],
    scopeLineLength: 689,
    scopeRanges: IC7610_SCOPE_RANGES,
    extParams: {
      usbAfLevel: { command: 0x1a, subcmd: 0x05, subext: [0x00, 0x82], dataBytes: 2, dataType: 'level' },
    },
  }),
  'IC-7760': baseProfile({
    modelId: 'IC-7760',
    profileName: 'Icom IC-7760',
    defaultCivAddress: 0xb2,
    aliases: ['IC-7760', 'IC7760'],
    scopeRanges: HF_SCOPE_RANGES_13,
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
