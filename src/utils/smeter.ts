/**
 * S-meter (signal strength meter) conversion utilities
 * Converts raw BCD values from CI-V 0x15/0x02 to physical S-units and dBm
 */

import { METER_CALIBRATION } from '../rig/IcomConstants';
import { LevelMeterReading } from '../types';

/**
 * S-meter calibration data for a specific radio model
 */
interface SMeterCalibration {
  S0: number;
  S9: number;
  S9_PLUS_60DB: number;
  HF_S9_DBM: number;
}

/**
 * Get S-meter calibration constants for a specific radio model
 * @param model - Radio model name (e.g., 'IC-705')
 * @returns Calibration constants, defaults to IC-705 if model not found
 */
function getCalibration(model: string = 'IC-705'): SMeterCalibration {
  const cal = METER_CALIBRATION.SMETER[model as keyof typeof METER_CALIBRATION.SMETER];
  if (!cal) {
    // Default to IC-705 if model not found
    console.warn(`S-meter calibration for model '${model}' not found, using IC-705 defaults`);
    return METER_CALIBRATION.SMETER['IC-705'];
  }
  return cal;
}

/**
 * Convert raw S-meter value to S-units (0-9+)
 * Uses linear interpolation based on calibration points
 *
 * @param raw - Raw BCD value (0-255)
 * @param cal - Calibration constants
 * @returns S-unit value (0-9+, supports decimals)
 */
function rawToSUnits(raw: number, cal: SMeterCalibration): number {
  // Clamp to valid range
  if (raw <= cal.S0) return 0;
  if (raw >= cal.S9_PLUS_60DB) {
    // Maximum S9+60dB = S9 + 60dB/6dB per S-unit = S9 + 10 S-units = S19
    return 9 + 60 / 6;
  }

  // Linear interpolation
  if (raw <= cal.S9) {
    // S0 to S9: linear from 0 to 9
    return (raw - cal.S0) * 9.0 / (cal.S9 - cal.S0);
  } else {
    // Above S9: each S-unit = 6dB
    const dbAboveS9 = (raw - cal.S9) * 60.0 / (cal.S9_PLUS_60DB - cal.S9);
    return 9 + dbAboveS9 / 6.0;
  }
}

/**
 * Convert raw S-meter value to dB above S9
 * Only meaningful when raw > S9 threshold
 *
 * @param raw - Raw BCD value (0-255)
 * @param cal - Calibration constants
 * @returns dB above S9, or undefined if below S9
 */
function rawToDbAboveS9(raw: number, cal: SMeterCalibration): number | undefined {
  if (raw <= cal.S9) {
    return undefined; // Below S9, no "dB above S9" concept
  }

  // Linear interpolation: S9 to S9+60dB
  const dbAboveS9 = (raw - cal.S9) * 60.0 / (cal.S9_PLUS_60DB - cal.S9);
  return Math.max(0, dbAboveS9); // Clamp to non-negative
}

/**
 * Estimate absolute power in dBm
 * Based on HF standard: S9 ≈ -73dBm
 * NOTE: This is an estimation and may vary by band, filter, and device settings
 *
 * @param sUnits - S-unit value
 * @param cal - Calibration constants
 * @returns Estimated power in dBm
 */
function estimateDpm(sUnits: number, cal: SMeterCalibration): number {
  // Each S-unit below S9 = 6dB
  // Each dB above S9 = 1dB
  const dbRelativeToS9 = (sUnits - 9) * 6.0;
  return cal.HF_S9_DBM + dbRelativeToS9;
}

/**
 * Format S-meter reading as human-readable string
 * Examples: "S0", "S4", "S9", "S9+10dB", "S9+60dB"
 *
 * @param sUnits - S-unit value
 * @param dbAboveS9 - dB above S9 (if any)
 * @returns Formatted string
 */
function formatSMeter(sUnits: number, dbAboveS9: number | undefined): string {
  if (dbAboveS9 !== undefined && dbAboveS9 > 0) {
    // Above S9: show as "S9+XdB"
    const roundedDb = Math.round(dbAboveS9);
    return `S9+${roundedDb}dB`;
  } else {
    // S0-S9: show as "SX"
    const roundedS = Math.floor(sUnits);
    return `S${roundedS}`;
  }
}

/**
 * Convert raw S-meter BCD value to complete reading with S-units, dB, and dBm
 *
 * @param raw - Raw BCD value (0-255) from CI-V 0x15/0x02
 * @param model - Radio model name (default: 'IC-705')
 * @returns Complete LevelMeterReading with all calculated fields
 *
 * @example
 * ```typescript
 * const reading = rawToSMeter(140, 'IC-705');
 * console.log(reading);
 * // {
 * //   raw: 140,
 * //   percent: 54.9,
 * //   sUnits: 9.99,
 * //   dbAboveS9: 9.92,
 * //   dBm: -63.08,
 * //   formatted: "S9+10dB"
 * // }
 * ```
 */
export function rawToSMeter(raw: number, model: string = 'IC-705'): LevelMeterReading {
  const cal = getCalibration(model);

  // Calculate all fields
  const sUnits = rawToSUnits(raw, cal);
  const dbAboveS9 = rawToDbAboveS9(raw, cal);
  const dBm = estimateDpm(sUnits, cal);
  const formatted = formatSMeter(sUnits, dbAboveS9);
  const percent = (raw / 255) * 100;

  return {
    raw,
    percent: Math.round(percent * 10) / 10, // Round to 1 decimal place
    sUnits: Math.round(sUnits * 100) / 100, // Round to 2 decimal places
    dbAboveS9: dbAboveS9 !== undefined ? Math.round(dbAboveS9 * 100) / 100 : undefined,
    dBm: Math.round(dBm * 100) / 100, // Round to 2 decimal places
    formatted
  };
}
