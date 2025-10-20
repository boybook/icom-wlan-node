import { EventEmitter } from 'events';
import { MODE_MAP, CONNECTOR_MODE_MAP } from './rig/IcomConstants';

export type UdpAddress = { ip: string; port: number };

export interface IcomCredentials {
  userName: string;
  password: string;
}

export interface IcomRigOptions extends IcomCredentials {
  control: UdpAddress; // Icom control service (UDP) address
}

export interface CivCommand {
  bytes: Buffer;
}

export interface AudioFrame {
  // LPCM 16bit mono 12kHz
  pcm16: Buffer;
}

export interface LoginResult {
  ok: boolean;
  errorCode?: number;
  connection?: string;
}

export interface StatusInfo {
  civPort: number;
  audioPort: number;
  authOK: boolean;
  connected: boolean;
}

export interface CapabilitiesInfo {
  civAddress?: number;
  audioName?: string;
  supportTX?: boolean;
}

export interface IcomRigEvents {
  login: (res: LoginResult) => void;
  status: (s: StatusInfo) => void;
  capabilities: (c: CapabilitiesInfo) => void;
  civ: (data: Buffer) => void;
  // Emitted for each complete CI-V frame (FE FE ... FD) extracted from CIV payload stream
  civFrame: (frame: Buffer) => void;
  audio: (frame: AudioFrame) => void;
  error: (err: Error) => void;
}

export interface Disposable {
  dispose(): void;
}

export type RigEventEmitter = EventEmitter & {
  on<U extends keyof IcomRigEvents>(event: U, listener: IcomRigEvents[U]): RigEventEmitter;
  emit<U extends keyof IcomRigEvents>(event: U, ...args: Parameters<IcomRigEvents[U]>): boolean;
};

// ============================================================================
// Modern API Types
// ============================================================================

/**
 * Operating mode for ICOM radios
 * LSB, USB, AM, CW, RTTY, FM, WFM, CW_R, RTTY_R, DV
 */
export type IcomMode = keyof typeof MODE_MAP;

/**
 * Connector data routing mode
 * MIC: Microphone, ACC: Accessory port, USB: USB audio, WLAN: Network audio
 */
export type ConnectorDataMode = keyof typeof CONNECTOR_MODE_MAP;

/**
 * Options for setting operating mode
 */
export interface SetModeOptions {
  /**
   * Enable data mode (e.g., USB-D for digital modes)
   * Uses CI-V command 0x26 instead of 0x06
   */
  dataMode?: boolean;
}

/**
 * Options for query operations (frequency, meters, etc.)
 */
export interface QueryOptions {
  /**
   * Timeout in milliseconds (default: 3000)
   */
  timeout?: number;
}

/**
 * Result of a meter reading operation (SWR, ALC, etc.)
 * @deprecated Use specific types like SwrReading, AlcReading instead
 */
export interface MeterReading {
  /**
   * Raw meter value as buffer
   */
  value: Buffer;
  /**
   * Whether the reading was successful
   */
  success: boolean;
}

// ============================================================================
// Meter Reading Types
// ============================================================================

/**
 * SWR (Standing Wave Ratio) meter reading
 * Represents antenna impedance matching quality
 */
export interface SwrReading {
  /**
   * Raw BCD value (0-300+)
   * Actual SWR = raw / 100
   * Example: 120 = SWR 1.2, 250 = SWR 2.5
   */
  raw: number;

  /**
   * Calculated SWR value (typically 1.0 - 3.0)
   * 1.0 = perfect match, >2.0 = poor match
   */
  swr: number;

  /**
   * Alert flag when SWR is too high (≥1.2)
   * High SWR can damage transmitter
   */
  alert: boolean;
}

/**
 * ALC (Automatic Level Control) meter reading
 * Represents transmitter output power control level
 */
export interface AlcReading {
  /**
   * Raw BCD value (0-255)
   */
  raw: number;

  /**
   * Percentage of maximum ALC (0-100%)
   */
  percent: number;

  /**
   * Alert flag when ALC exceeds safe threshold (>120)
   * Excessive ALC indicates over-driving the transmitter
   */
  alert: boolean;
}

/**
 * WLAN connector audio level reading
 * Represents network audio signal strength/quality
 */
export interface WlanLevelReading {
  /**
   * Raw value (0-255)
   * Higher values indicate stronger signal
   */
  raw: number;

  /**
   * Percentage of maximum level (0-100%)
   */
  percent: number;
}

/**
 * Generic level meter (0-255) reading
 * For CI-V 0x15/0x02 experimental level meter
 */
export interface LevelMeterReading {
  /** Raw 0-255 value */
  raw: number;
  /** Percentage (0-100%) */
  percent: number;
}
