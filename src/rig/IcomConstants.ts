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
