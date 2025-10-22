// Export types (includes ConnectionPhase, ConnectionMetrics, etc.)
export * from './types';

// Export main class
export { IcomControl } from './rig/IcomControl';

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
export { AUDIO_RATE } from './rig/IcomAudio';

// Export error handling utilities (optional, for robustness)
export {
  setupGlobalErrorHandlers,
  setupBasicErrorProtection,
  GlobalErrorHandlerOptions
} from './utils/errorHandling';
