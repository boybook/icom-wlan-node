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
  // Connection monitoring events
  connectionLost: (info: ConnectionLostInfo) => void;
  connectionRestored: (info: ConnectionRestoredInfo) => void;
  reconnectAttempting: (info: ReconnectAttemptInfo) => void;
  reconnectFailed: (info: ReconnectFailedInfo) => void;
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

/**
 * Squelch status reading (CI-V 0x15/0x01)
 * Indicates whether noise/signal squelch gate is open or closed
 */
export interface SquelchStatusReading {
  /** Raw BCD value (0 or 1) */
  raw: number;
  /** True if squelch is open (signal present), false if closed (no signal) */
  isOpen: boolean;
}

/**
 * Audio squelch reading (CI-V 0x15/0x05)
 * Indicates audio squelch state
 */
export interface AudioSquelchReading {
  /** Raw BCD value (0 or 1) */
  raw: number;
  /** True if audio squelch is open, false if closed */
  isOpen: boolean;
}

/**
 * OVF (ADC overload) status reading (CI-V 0x15/0x07)
 * Indicates whether the ADC (analog-to-digital converter) is overloading
 */
export interface OvfStatusReading {
  /** Raw BCD value (0 or 1) */
  raw: number;
  /** True if ADC is overloading, false if normal */
  isOverload: boolean;
}

/**
 * Power output level reading (CI-V 0x15/0x11)
 * Represents transmitter output power level
 */
export interface PowerLevelReading {
  /**
   * Raw BCD value (0-255)
   * Calibration: 0143≈50%, 0213≈100%
   */
  raw: number;
  /** Percentage of maximum power (0-100%) */
  percent: number;
}

/**
 * COMP (voice compression) level reading (CI-V 0x15/0x14)
 * Represents speech compressor level during transmission
 */
export interface CompLevelReading {
  /** Raw BCD value (0-255) */
  raw: number;
  /** Percentage of maximum compression (0-100%) */
  percent: number;
}

/**
 * Voltage reading (CI-V 0x15/0x15)
 * Represents power supply voltage
 */
export interface VoltageReading {
  /**
   * Raw BCD value (0-255)
   * Calibration: 0075≈5V, 0241≈16V
   */
  raw: number;
  /** Voltage in volts */
  volts: number;
}

/**
 * Current reading (CI-V 0x15/0x16)
 * Represents power supply current draw
 */
export interface CurrentReading {
  /**
   * Raw BCD value (0-255)
   * Calibration: 0121≈2A, 0241≈4A
   */
  raw: number;
  /** Current in amperes */
  amps: number;
}

// ============================================================================
// Connection Monitoring Types
// ============================================================================

/**
 * Connection state enumeration
 * Represents the current state of a UDP session
 */
export enum ConnectionState {
  /** Connection is active and receiving data */
  CONNECTED = 'CONNECTED',
  /** Connection has been lost (timeout detected) */
  DISCONNECTED = 'DISCONNECTED',
  /** Attempting to restore connection */
  RECONNECTING = 'RECONNECTING'
}

/**
 * Connection phase state machine
 * Represents the high-level connection lifecycle state
 */
export enum ConnectionPhase {
  /** Initial state or fully disconnected */
  IDLE = 'IDLE',
  /** Establishing connection (AreYouThere, Login, sub-sessions) */
  CONNECTING = 'CONNECTING',
  /** All sessions established and ready */
  CONNECTED = 'CONNECTED',
  /** Actively disconnecting */
  DISCONNECTING = 'DISCONNECTING',
  /** Attempting to reconnect after connection loss */
  RECONNECTING = 'RECONNECTING'
}

/**
 * Connection session tracking information
 * Used to prevent race conditions and track connection lifecycle
 */
export interface ConnectionSession {
  /** Current connection phase */
  phase: ConnectionPhase;
  /** Unique session ID to prevent race conditions */
  sessionId: number;
  /** When this connection session started */
  startTime: number;
  /** When the connection was last lost (for downtime calculation) */
  lastDisconnectTime?: number;
}

/**
 * Connection metrics for observability
 */
export interface ConnectionMetrics {
  /** Current connection phase */
  phase: ConnectionPhase;
  /** Current session ID */
  sessionId: number;
  /** Total uptime in milliseconds (since last successful connect) */
  uptime: number;
  /** Individual session states */
  sessions: {
    control: ConnectionState;
    civ: ConnectionState;
    audio: ConnectionState;
  };
  /** Last disconnect timestamp (if any) */
  lastDisconnectTime?: number;
  /** Whether currently reconnecting */
  isReconnecting: boolean;
}

/**
 * UDP session type identifier
 */
export enum SessionType {
  /** Main control session (login, status, token management) */
  CONTROL = 'CONTROL',
  /** CI-V command session */
  CIV = 'CIV',
  /** Audio streaming session */
  AUDIO = 'AUDIO'
}

/**
 * Information about a connection loss event
 */
export interface ConnectionLostInfo {
  /** Which session lost connection */
  sessionType: SessionType;
  /** Reason for disconnection */
  reason: string;
  /** Time since last received data (ms) */
  timeSinceLastData: number;
  /** Timestamp when the event occurred */
  timestamp: number;
}

/**
 * Information about a connection restored event
 */
export interface ConnectionRestoredInfo {
  /** Which session was restored */
  sessionType: SessionType;
  /** How long the connection was down (ms) */
  downtime: number;
  /** Timestamp when the connection was restored */
  timestamp: number;
}

/**
 * Information about a reconnection attempt
 */
export interface ReconnectAttemptInfo {
  /** Which session is attempting to reconnect */
  sessionType: SessionType;
  /** Current attempt number (1-based) */
  attemptNumber: number;
  /** Delay before this attempt (ms) */
  delay: number;
  /** Timestamp of this attempt */
  timestamp: number;
  /** Whether this is a full reconnect (all sessions) */
  fullReconnect: boolean;
}

/**
 * Information about a failed reconnection attempt
 */
export interface ReconnectFailedInfo {
  /** Which session failed to reconnect */
  sessionType: SessionType;
  /** Attempt number that failed */
  attemptNumber: number;
  /** Error that caused the failure */
  error: string;
  /** Timestamp of the failure */
  timestamp: number;
  /** Whether this was a full reconnect attempt */
  fullReconnect: boolean;
  /** Whether we will retry */
  willRetry: boolean;
  /** Next retry delay (ms), if retrying */
  nextRetryDelay?: number;
}

/**
 * Reason for disconnection
 * Used to distinguish between different types of disconnections
 */
export enum DisconnectReason {
  /** User explicitly called disconnect() */
  USER_REQUEST = 'user_request',
  /** Connection timed out */
  TIMEOUT = 'timeout',
  /** Cleanup after connection failure */
  CLEANUP = 'cleanup',
  /** Error occurred during connection */
  ERROR = 'error',
  /** Network connection was lost */
  NETWORK_LOST = 'network_lost'
}

/**
 * Options for disconnect() method
 */
export interface DisconnectOptions {
  /**
   * Reason for disconnection
   * Used to generate appropriate error messages and logs
   */
  reason?: DisconnectReason;

  /**
   * Silent mode - don't throw exceptions or emit error events
   * Useful for cleanup operations where exceptions are not desired
   * Default: false
   */
  silent?: boolean;
}

/**
 * Configuration for connection monitoring
 */
export interface ConnectionMonitorConfig {
  /**
   * Timeout threshold in milliseconds
   * If no data received within this period, connection is considered lost
   * Default: 5000ms (5 seconds)
   */
  timeout?: number;

  /**
   * How often to check for timeout (ms)
   * Default: 1000ms (1 second)
   */
  checkInterval?: number;

  /**
   * Enable automatic reconnection attempts
   * Default: false
   */
  autoReconnect?: boolean;

  /**
   * Maximum number of reconnection attempts
   * Set to undefined for infinite retries
   * Default: undefined (infinite retries)
   */
  maxReconnectAttempts?: number;

  /**
   * Base delay between reconnection attempts (ms)
   * Uses exponential backoff: attempt N uses delay * 2^(N-1)
   * Default: 2000ms (2 seconds)
   */
  reconnectBaseDelay?: number;

  /**
   * Maximum delay between reconnection attempts (ms)
   * Caps the exponential backoff
   * Default: 30000ms (30 seconds)
   */
  reconnectMaxDelay?: number;
}
