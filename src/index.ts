// Export types (includes ConnectionPhase, ConnectionMetrics, etc.)
export * from './types';

// Export main class
export { IcomControl } from './rig/IcomControl';
export { IcomScopeService } from './scope/IcomScopeService';
export { IcomScopeCommands } from './scope/IcomScopeCommands';

// Export constants and enums
export {
  MODE_MAP,
  CONNECTOR_MODE_MAP,
  DEFAULT_CONTROLLER_ADDR,
  METER_THRESHOLDS,
  METER_CALIBRATION,
  getModeCode,
  getConnectorModeCode,
  getModeString,
  getConnectorModeString,
  getFilterString,
  rawToPowerPercent,
  rawToVoltage,
  rawToCurrent
} from './rig/IcomConstants';

// Export BCD utilities
export { parseTwoByteBcd, intToTwoByteBcd } from './utils/bcd';

// Export low-level utilities (for advanced users)
export { IcomRigCommands } from './rig/IcomRigCommands';
export { CIV } from './rig/IcomCivSpec';
export { buildCivFrame, encodeFrequencyBcdLE, decodeFrequencyBcdLE, encodeBcdBE, decodeBcdBE } from './rig/IcomCivFrame';
export { ICOM_PROFILES, resolveIcomProfile, getProfileByModel, interpolateCalibration } from './rig/IcomProfiles';
export { AUDIO_RATE } from './rig/IcomAudio';

// Export error handling utilities (optional, for robustness)
export {
  setupGlobalErrorHandlers,
  setupBasicErrorProtection,
  GlobalErrorHandlerOptions
} from './utils/errorHandling';

// Export disconnect error utilities
export {
  ConnectionAbortedError,
  UnsupportedCommandError,
  getDisconnectMessage
} from './utils/errors';
