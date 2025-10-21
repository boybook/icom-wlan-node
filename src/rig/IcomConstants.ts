/**
 * ICOM radio constants and mappings
 * Based on FT8CN's IcomRigConstant.java
 */

/**
 * Operating modes supported by ICOM radios
 * LSB:0, USB:1, AM:2, CW:3, RTTY:4, FM:5, WFM:6, CW_R:7, RTTY_R:8, DV:17
 */
export const MODE_MAP = {
  LSB: 0x00,      // Lower Side Band (下边带)
  USB: 0x01,      // Upper Side Band (上边带)
  AM: 0x02,       // Amplitude Modulation (调幅)
  CW: 0x03,       // Continuous Wave (连续波/莫尔斯码)
  RTTY: 0x04,     // Radio Teletype (频移键控)
  FM: 0x05,       // Frequency Modulation (调频)
  WFM: 0x06,      // Wide FM (宽带调频)
  CW_R: 0x07,     // CW Reverse (反向连续波)
  RTTY_R: 0x08,   // RTTY Reverse (反向频移键控)
  DV: 0x17        // Digital Voice (数字语音, decimal 23)
} as const;

/**
 * Connector data routing modes
 * Based on ICOM's connector data mode settings
 */
export const CONNECTOR_MODE_MAP = {
  MIC: 0x00,      // Microphone input
  ACC: 0x01,      // ACC (Accessory) port
  USB: 0x02,      // USB audio
  WLAN: 0x03      // WLAN (network) audio
} as const;

/**
 * Default controller address (typically 0xE0 for PC/controller)
 */
export const DEFAULT_CONTROLLER_ADDR = 0xe0;

/**
 * Helper function to get mode code from string
 */
export function getModeCode(mode: keyof typeof MODE_MAP): number {
  return MODE_MAP[mode];
}

/**
 * Helper function to get connector mode code from string
 */
export function getConnectorModeCode(mode: keyof typeof CONNECTOR_MODE_MAP): number {
  return CONNECTOR_MODE_MAP[mode];
}

/**
 * Helper function to get mode string from code
 */
export function getModeString(code: number): string | undefined {
  const entry = Object.entries(MODE_MAP).find(([_, value]) => value === code);
  return entry?.[0];
}

/**
 * Helper function to get connector mode string from code
 */
export function getConnectorModeString(code: number): string | undefined {
  const entry = Object.entries(CONNECTOR_MODE_MAP).find(([_, value]) => value === code);
  return entry?.[0];
}

/**
 * ICOM filter code to string mapping
 * Common rigs use 0x01(FIL1), 0x02(FIL2), 0x03(FIL3)
 */
export function getFilterString(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  if (code === 0x01) return 'FIL1';
  if (code === 0x02) return 'FIL2';
  if (code === 0x03) return 'FIL3';
  return 'FIL' + code;
}

/**
 * Meter alert thresholds
 * Based on FT8CN's IcomRigConstant.java
 */
export const METER_THRESHOLDS = {
  /**
   * SWR alert threshold (raw value)
   * Alert when SWR ≥ 1.2 (raw value ≥ 120)
   */
  SWR_ALERT: 120,

  /**
   * ALC maximum alert threshold (raw value)
   * Alert when ALC > 120
   */
  ALC_ALERT_MAX: 120,

  /**
   * Maximum ALC value for percentage calculation
   */
  ALC_MAX: 255,

  /**
   * Maximum WLAN level value for percentage calculation
   */
  WLAN_LEVEL_MAX: 255
} as const;

/**
 * Period for meter polling during TX (milliseconds)
 * Matches FT8CN's IComPacketTypes.METER_TIMER_PERIOD_MS
 */
export const METER_TIMER_PERIOD_MS = 500;

/**
 * Meter calibration constants for physical unit conversion
 * Based on IC-705 official CI-V reference manual
 */
export const METER_CALIBRATION = {
  /**
   * Power level (CI-V 0x15/0x11) calibration points
   * Used for converting raw BCD to percentage
   */
  POWER: {
    /** 50% power reference point (raw=143, percent=50) */
    HALF: { raw: 143, percent: 50 },
    /** 100% power reference point (raw=213, percent=100) */
    FULL: { raw: 213, percent: 100 }
  },

  /**
   * Voltage (CI-V 0x15/0x15) calibration points
   * Used for converting raw BCD to volts
   */
  VOLTAGE: {
    /** Low voltage reference: 5V (raw=75) */
    LOW: { raw: 75, volts: 5.0 },
    /** High voltage reference: 16V (raw=241) */
    HIGH: { raw: 241, volts: 16.0 }
  },

  /**
   * Current (CI-V 0x15/0x16) calibration points
   * Used for converting raw BCD to amperes
   */
  CURRENT: {
    /** Low current reference: 2A (raw=121) */
    LOW: { raw: 121, amps: 2.0 },
    /** High current reference: 4A (raw=241) */
    HIGH: { raw: 241, amps: 4.0 }
  }
} as const;

/**
 * Linear interpolation helper for meter value conversion
 * @param raw - Raw BCD value
 * @param x1 - Lower calibration point (raw value)
 * @param y1 - Lower calibration point (physical value)
 * @param x2 - Upper calibration point (raw value)
 * @param y2 - Upper calibration point (physical value)
 * @returns Interpolated physical value
 */
function linearInterpolate(raw: number, x1: number, y1: number, x2: number, y2: number): number {
  // Clamp to range
  if (raw <= x1) return y1;
  if (raw >= x2) return y2;
  // Linear interpolation: y = y1 + (raw - x1) * (y2 - y1) / (x2 - x1)
  return y1 + ((raw - x1) * (y2 - y1)) / (x2 - x1);
}

/**
 * Convert raw power level to percentage
 * @param raw - Raw BCD value (0-255)
 * @returns Power percentage (0-100%)
 */
export function rawToPowerPercent(raw: number): number {
  return linearInterpolate(
    raw,
    METER_CALIBRATION.POWER.HALF.raw,
    METER_CALIBRATION.POWER.HALF.percent,
    METER_CALIBRATION.POWER.FULL.raw,
    METER_CALIBRATION.POWER.FULL.percent
  );
}

/**
 * Convert raw voltage reading to volts
 * @param raw - Raw BCD value (0-255)
 * @returns Voltage in volts
 */
export function rawToVoltage(raw: number): number {
  return linearInterpolate(
    raw,
    METER_CALIBRATION.VOLTAGE.LOW.raw,
    METER_CALIBRATION.VOLTAGE.LOW.volts,
    METER_CALIBRATION.VOLTAGE.HIGH.raw,
    METER_CALIBRATION.VOLTAGE.HIGH.volts
  );
}

/**
 * Convert raw current reading to amperes
 * @param raw - Raw BCD value (0-255)
 * @returns Current in amperes
 */
export function rawToCurrent(raw: number): number {
  return linearInterpolate(
    raw,
    METER_CALIBRATION.CURRENT.LOW.raw,
    METER_CALIBRATION.CURRENT.LOW.amps,
    METER_CALIBRATION.CURRENT.HIGH.raw,
    METER_CALIBRATION.CURRENT.HIGH.amps
  );
}
