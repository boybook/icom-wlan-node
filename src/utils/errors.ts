import { DisconnectReason, ConnectionPhase } from '../types';

/**
 * Get human-readable message for a disconnect reason
 */
export function getDisconnectMessage(reason: DisconnectReason): string {
  switch (reason) {
    case DisconnectReason.USER_REQUEST:
      return 'Connection closed by user request';
    case DisconnectReason.TIMEOUT:
      return 'Connection timed out';
    case DisconnectReason.CLEANUP:
      return 'Connection cleanup';
    case DisconnectReason.ERROR:
      return 'Connection closed due to error';
    case DisconnectReason.NETWORK_LOST:
      return 'Network connection lost';
    default:
      return 'Connection closed';
  }
}

/**
 * Error thrown when a connection attempt is aborted
 * This is typically used when disconnect() is called during connect()
 */
export class ConnectionAbortedError extends Error {
  public readonly name = 'ConnectionAbortedError';

  constructor(
    public readonly reason: DisconnectReason,
    public readonly sessionId: number,
    public readonly phase: ConnectionPhase,
    public readonly context?: Record<string, any>
  ) {
    super(getDisconnectMessage(reason));
    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConnectionAbortedError);
    }
  }

  /**
   * Check if this error should be silent (not thrown to user)
   * Cleanup and timeout errors during connect are typically expected
   */
  isSilent(): boolean {
    return this.reason === DisconnectReason.CLEANUP ||
           this.reason === DisconnectReason.TIMEOUT;
  }

  /**
   * Get detailed error information for debugging
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      sessionId: this.sessionId,
      phase: this.phase,
      context: this.context
    };
  }
}


export interface UnsupportedCommandContext {
  modelId?: string;
  commandName: string;
  civCommand?: number | string;
  reason?: string;
}

export class UnsupportedCommandError extends Error {
  public readonly modelId?: string;
  public readonly commandName: string;
  public readonly civCommand?: number | string;
  public readonly reason?: string;

  constructor(context: UnsupportedCommandContext) {
    const details = [
      context.modelId ? `model=${context.modelId}` : undefined,
      context.civCommand !== undefined ? `civ=${context.civCommand}` : undefined,
      context.reason,
    ].filter(Boolean).join(', ');
    super(`Unsupported ICOM CI-V command '${context.commandName}'${details ? ` (${details})` : ''}`);
    this.name = 'UnsupportedCommandError';
    this.modelId = context.modelId;
    this.commandName = context.commandName;
    this.civCommand = context.civCommand;
    this.reason = context.reason;
  }
}
