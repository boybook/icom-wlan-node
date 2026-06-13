import { EventEmitter } from 'events';
import { CapCapabilitiesPacket, Cmd, ControlPacket, LoginPacket, LoginResponsePacket, RadioCapPacket, Sizes, StatusPacket, TokenPacket, TokenType, ConnInfoPacket, AUDIO_SAMPLE_RATE, XIEGU_TX_BUFFER_SIZE, PingPacket, CivPacket, AudioPacket } from '../core/IcomPackets';
import { dbg, dbgV } from '../utils/debug';
import { Session } from '../core/Session';
import { IcomRigEvents, IcomRigOptions, LoginResult, StatusInfo, CapabilitiesInfo, RigEventEmitter, IcomMode, ConnectorDataMode, SetModeOptions, SendMorseOptions, QueryOptions, SwrReading, AlcReading, WlanLevelReading, LevelMeterReading, SquelchStatusReading, AudioSquelchReading, OvfStatusReading, PowerLevelReading, CompLevelReading, VoltageReading, CurrentReading, SessionType, ConnectionState, ConnectionLostInfo, ConnectionRestoredInfo, ConnectionMonitorConfig, ReconnectAttemptInfo, ReconnectFailedInfo, ConnectionPhase, ConnectionSession, ConnectionMetrics, DisconnectReason, DisconnectOptions, TunerStatusReading, TunerState, LevelReading, IcomScopeSpanInfo, IcomScopeMode, IcomScopeModeInfo, IcomScopeEdgeInfo, IcomScopeFixedEdgeInfo, IcomSpectrumDisplayState, IcomSpectrumDisplayConfig, IcomModelId, IcomFunctionName, IcomLevelName, IcomParameterName, IcomVfoName, IcomVfoOperation, IcomRepeaterShift, IcomSpectrumSpeed, IcomSpectrumCenterType, IcomAudioIfSource } from '../types';
import { IcomCiv } from './IcomCiv';
import { IcomAudio } from './IcomAudio';
import { IcomRigCommands } from './IcomRigCommands';
import { getModeCode, getConnectorModeCode, DEFAULT_CONTROLLER_ADDR, METER_THRESHOLDS, METER_TIMER_PERIOD_MS, MODE_MAP } from './IcomConstants';
import { parseTwoByteBcd, intToTwoByteBcd } from '../utils/bcd';
import { ConnectionAbortedError, getDisconnectMessage, UnsupportedCommandError } from '../utils/errors';
import { rawToSMeter } from '../utils/smeter';
import { IcomScopeCommands } from '../scope/IcomScopeCommands';
import { parseIcomBcdFreqLE } from '../scope/IcomScopeParser';
import { IcomScopeService } from '../scope/IcomScopeService';
import { decodeBcdBE, decodeFrequencyBcdLE, encodeBcdBE, encodeFrequencyBcdLE } from './IcomCivFrame';
import { CIV } from './IcomCivSpec';
import { IcomExtParam, IcomProfile, getProfileByModel, interpolateCalibration, resolveIcomProfile } from './IcomProfiles';
import { IcomCivRequestManager } from './IcomCivRequestManager';

const DEFAULT_SCOPE_SPANS_HZ = [25000000, 10000000, 5000000, 2500000, 1000000, 500000, 250000, 100000, 50000, 25000, 10000, 5000, 2500] as const;

function modeCodeToName(mode: 0 | 1 | 2 | 3): IcomScopeMode {
  switch (mode) {
    case 0: return 'center';
    case 1: return 'fixed';
    case 2: return 'scroll-center';
    case 3: return 'scroll-fixed';
  }
}

function modeNameToCode(mode: IcomScopeMode): 0 | 1 | 2 | 3 {
  switch (mode) {
    case 'center': return 0;
    case 'fixed': return 1;
    case 'scroll-center': return 2;
    case 'scroll-fixed': return 3;
  }
}

type LevelSpec = {
  command: number;
  subcmd: number;
  dataBytes: number;
  dataType: IcomExtParam['dataType'];
  publicToRaw?: (value: number) => number;
  rawToPublic?: (raw: number) => number;
};

const FUNCTION_SPECS: Partial<Record<IcomFunctionName, { command: number; subcmd: number; payloadPrefix?: number[]; readPrefix?: number[] }>> = {
  NB: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_NB },
  NR: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_NR },
  COMP: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_COMP },
  VOX: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_VOX },
  TONE: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_TONE },
  TSQL: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_TSQL },
  SBKIN: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_BKIN },
  FBKIN: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_BKIN },
  MON: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_MON },
  ANF: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_ANF },
  MN: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_MN },
  LOCK: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_DIAL_LK },
  RIT: { command: CIV.C_CTL_RIT, subcmd: CIV.S_RIT },
  XIT: { command: CIV.C_CTL_RIT, subcmd: CIV.S_XIT },
  TUNER: { command: CIV.C_CTL_PTT, subcmd: CIV.S_ANT_TUN },
  APF: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_APF },
  AFC: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_AFC },
  VSC: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_VSC },
  DUAL_WATCH: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_MEM_DUALMODE },
  SATMODE: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_MEM_SATMODE },
  SCOPE: { command: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_STS },
  SPECTRUM: { command: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_DOP },
  SPECTRUM_HOLD: { command: CIV.C_CTL_SCP, subcmd: CIV.S_SCP_HLD, payloadPrefix: [0], readPrefix: [0] },
  OVF_STATUS: { command: CIV.C_RD_SQSM, subcmd: CIV.S_OVF },
  DIGI_SEL: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_DIGISEL },
  IPP: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_IPP },
  TX_INHIBIT: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_TX_INHIBIT },
  DPP: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_DPP },
};

function keySpeedWpmToRaw(wpm: number): number {
  const target = Math.max(6, Math.min(48, Math.round(wpm)));
  return CW_LOOKUP.find(([, speed]) => speed === target)?.[0] ?? CW_LOOKUP[0][0];
}

function keySpeedRawToWpm(raw: number): number {
  return CW_LOOKUP.find(([rigValue]) => rigValue >= raw)?.[1] ?? 48;
}

const LEVEL_SPECS: Partial<Record<IcomLevelName, LevelSpec>> = {
  AF: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_AF, dataBytes: 2, dataType: 'level' },
  RF: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_RF, dataBytes: 2, dataType: 'level' },
  SQL: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_SQL, dataBytes: 2, dataType: 'level' },
  IF: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_IF, dataBytes: 2, dataType: 'level' },
  APF: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_APF, dataBytes: 2, dataType: 'level' },
  NR: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_NR, dataBytes: 2, dataType: 'level' },
  NB: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_NB, dataBytes: 2, dataType: 'level' },
  PBT_IN: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_PBTIN, dataBytes: 2, dataType: 'level' },
  PBT_OUT: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_PBTOUT, dataBytes: 2, dataType: 'level' },
  CWPITCH: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_CWPITCH, dataBytes: 2, dataType: 'int', publicToRaw: (hz) => Math.round((Math.max(300, Math.min(900, hz)) - 300) * 255 / 600), rawToPublic: (raw) => Math.round(300 + raw * 600 / 255) },
  RFPOWER: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_RFPOWER, dataBytes: 2, dataType: 'level' },
  MICGAIN: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_MICGAIN, dataBytes: 2, dataType: 'level' },
  KEYSPD: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_KEYSPD, dataBytes: 2, dataType: 'int', publicToRaw: keySpeedWpmToRaw, rawToPublic: keySpeedRawToWpm },
  NOTCHF_RAW: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_NOTCHF, dataBytes: 2, dataType: 'level' },
  COMP: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_COMP, dataBytes: 2, dataType: 'level' },
  BKINDL: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_BKINDL, dataBytes: 2, dataType: 'level' },
  BALANCE: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_BALANCE, dataBytes: 2, dataType: 'level' },
  VOXGAIN: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_VOXGAIN, dataBytes: 2, dataType: 'level' },
  ANTIVOX: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_ANTIVOX, dataBytes: 2, dataType: 'level' },
  MONITOR_GAIN: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_MON, dataBytes: 2, dataType: 'level' },
  DRIVE_GAIN: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_DRIVE, dataBytes: 2, dataType: 'level' },
  DIGI_SEL_LEVEL: { command: CIV.C_CTL_LVL, subcmd: CIV.S_LVL_DIGI, dataBytes: 2, dataType: 'level' },
  AGC: { command: CIV.C_CTL_FUNC, subcmd: CIV.S_FUNC_AGC, dataBytes: 1, dataType: 'int' },
  AGC_TIME: { command: CIV.C_CTL_MEM, subcmd: 0x04, dataBytes: 1, dataType: 'int' },
};

const CW_LOOKUP: Array<[number, number]> = [
  [0, 6], [7, 7], [12, 8], [19, 9], [25, 10], [31, 11], [37, 12], [43, 13],
  [49, 14], [55, 15], [61, 16], [67, 17], [73, 18], [79, 19], [84, 20],
  [91, 21], [97, 22], [103, 23], [108, 24], [114, 25], [121, 26], [128, 27],
  [134, 28], [140, 29], [144, 30], [151, 31], [156, 32], [164, 33],
  [169, 34], [175, 35], [182, 36], [188, 37], [192, 38], [199, 39],
  [203, 40], [211, 41], [215, 42], [224, 43], [229, 44], [234, 45],
  [239, 46], [244, 47], [250, 48],
];

export class IcomControl {
  private ev: RigEventEmitter = new EventEmitter() as RigEventEmitter;
  private sess: Session; // control
  private civSess: Session;
  private audioSess: Session;
  public civ: IcomCiv;
  public audio: IcomAudio;
  public scope: IcomScopeService;
  private options: IcomRigOptions;
  private rigName = '';
  private macAddress: Buffer = Buffer.alloc(6);
  private tokenTimer?: NodeJS.Timeout;
  private civAssembleBuf: Buffer = Buffer.alloc(0); // CIV stream reassembler
  private civRequestManager: IcomCivRequestManager;
  private meterTimer?: NodeJS.Timeout;
  private activeProfile: IcomProfile = getProfileByModel('generic-modern-icom');
  private lastFilter: 1 | 2 | 3 = 1;
  private cwQueue: Promise<void> = Promise.resolve();
  private cwGeneration = 0;

  // Connection state machine (replaces old fragmented state flags)
  private connectionSession: ConnectionSession = {
    phase: ConnectionPhase.IDLE,
    sessionId: 0,
    startTime: Date.now()
  };
  private nextSessionId = 1;
  // Map of sessionId -> abort function for cancelling ongoing connection attempts
  private abortHandlers = new Map<number, (reason: DisconnectReason, silent: boolean) => void>();

  // Unified connection monitoring
  private monitorTimer?: NodeJS.Timeout;
  private monitorConfig: ConnectionMonitorConfig & {
    timeout: number;
    checkInterval: number;
    autoReconnect: boolean;
    reconnectBaseDelay: number;
    reconnectMaxDelay: number;
  } = {
    timeout: 5000,
    checkInterval: 1000,
    autoReconnect: false,
    maxReconnectAttempts: undefined, // undefined = infinite retries
    reconnectBaseDelay: 2000,
    reconnectMaxDelay: 30000
  };

  constructor(options: IcomRigOptions) {
    this.options = { ...options, model: options.model ?? 'auto' };
    this.activeProfile = resolveIcomProfile({ requestedModel: this.options.model });

    // Setup control session
    this.sess = new Session({ ip: options.control.ip, port: options.control.port }, {
      onData: (data) => this.onData(data),
      onSendError: (e) => this.ev.emit('error', e)
    });
    this.sess.sessionType = SessionType.CONTROL;

    // Setup CIV session
    this.civSess = new Session({ ip: options.control.ip, port: 0 }, {
      onData: (b) => this.onCivData(b),
      onSendError: (e) => this.ev.emit('error', e)
    });
    this.civSess.sessionType = SessionType.CIV;
    this.civSess.open();

    // Setup audio session
    this.audioSess = new Session({ ip: options.control.ip, port: 0 }, {
      onData: (b) => this.onAudioData(b),
      onSendError: (e) => this.ev.emit('error', e)
    });
    this.audioSess.sessionType = SessionType.AUDIO;
    this.audioSess.open();

    this.civ = new IcomCiv(this.civSess);
    this.audio = new IcomAudio(this.audioSess);
    this.scope = new IcomScopeService();
    this.civRequestManager = new IcomCivRequestManager(this.ev);
    this.scope.on('scopeSegment', (segment) => this.ev.emit('scopeSegment', segment));
    this.scope.on('scopeFrame', (frame) => this.ev.emit('scopeFrame', frame));
  }

  get events(): RigEventEmitter { return this.ev; }

  get profile(): IcomProfile { return this.activeProfile; }

  private resolveActiveProfile(context: { rigName?: string; civAddress?: number } = {}) {
    const next = resolveIcomProfile({
      requestedModel: this.options.model,
      rigName: context.rigName ?? this.rigName,
      civAddress: context.civAddress ?? this.civ.civAddress,
    });
    if (this.options.model && this.options.model !== 'auto' && context.civAddress !== undefined && next.defaultCivAddress !== (context.civAddress & 0xff)) {
      dbg(`Configured profile ${next.modelId} default CI-V 0x${next.defaultCivAddress.toString(16)} differs from radio CI-V 0x${(context.civAddress & 0xff).toString(16)}`);
    }
    if (next.modelId !== this.activeProfile.modelId) {
      dbg(`ICOM profile selected: ${next.profileName}`);
    }
    this.activeProfile = next;
    this.lastFilter = next.defaultFilter;
  }

  private getProfileModelId(): IcomModelId {
    return this.activeProfile.modelId;
  }


  // ============================================================================
  // State Machine Management
  // ============================================================================

  /**
   * Transition to a new connection phase with logging
   * @private
   */
  private transitionTo(newPhase: ConnectionPhase, reason: string) {
    const oldPhase = this.connectionSession.phase;
    if (oldPhase === newPhase) return; // No-op if already in target phase

    dbg(`State transition: ${oldPhase} → ${newPhase} (${reason})`);
    this.connectionSession.phase = newPhase;

    // Update timestamps based on phase
    if (newPhase === ConnectionPhase.CONNECTING || newPhase === ConnectionPhase.RECONNECTING) {
      this.connectionSession.startTime = Date.now();
    } else if (newPhase === ConnectionPhase.IDLE) {
      // Record disconnect time when entering IDLE
      this.connectionSession.lastDisconnectTime = Date.now();
    }
  }

  /**
   * Validate if a state transition is legal
   * @private
   */
  private canTransitionTo(targetPhase: ConnectionPhase): boolean {
    const current = this.connectionSession.phase;

    // Define valid state transitions
    const validTransitions: Record<ConnectionPhase, ConnectionPhase[]> = {
      [ConnectionPhase.IDLE]: [ConnectionPhase.CONNECTING],
      [ConnectionPhase.CONNECTING]: [ConnectionPhase.CONNECTED, ConnectionPhase.DISCONNECTING, ConnectionPhase.IDLE],
      [ConnectionPhase.CONNECTED]: [ConnectionPhase.DISCONNECTING, ConnectionPhase.RECONNECTING],
      [ConnectionPhase.DISCONNECTING]: [ConnectionPhase.IDLE],
      [ConnectionPhase.RECONNECTING]: [ConnectionPhase.CONNECTED, ConnectionPhase.IDLE]
    };

    return validTransitions[current]?.includes(targetPhase) ?? false;
  }

  /**
   * Abort an ongoing connection attempt by session ID
   * @private
   */
  private abortConnectionAttempt(
    sessionId: number,
    reason: DisconnectReason,
    silent: boolean = false
  ) {
    const abortHandler = this.abortHandlers.get(sessionId);
    if (abortHandler) {
      const message = getDisconnectMessage(reason);
      dbg(`Aborting connection session ${sessionId}: ${message} (silent=${silent})`);
      abortHandler(reason, silent);
      this.abortHandlers.delete(sessionId);
    }
  }

  // ============================================================================
  // Connection Methods
  // ============================================================================

  /**
   * Connect to the rig
   * Idempotent: multiple calls during CONNECTING phase are safe
   * @throws Error if called during DISCONNECTING phase
   */
  async connect() {
    const currentPhase = this.connectionSession.phase;

    // If already connected, return immediately
    if (currentPhase === ConnectionPhase.CONNECTED) {
      dbg('connect() called but already CONNECTED - returning immediately');
      return;
    }

    // If already connecting or reconnecting, wait for completion (idempotent)
    if (currentPhase === ConnectionPhase.CONNECTING || currentPhase === ConnectionPhase.RECONNECTING) {
      dbg(`connect() called while ${currentPhase} - idempotent behavior, will wait`);
      // Return a promise that resolves when state changes to CONNECTED
      return new Promise<void>((resolve, reject) => {
        const checkState = () => {
          if (this.connectionSession.phase === ConnectionPhase.CONNECTED) {
            resolve();
          } else if (this.connectionSession.phase === ConnectionPhase.IDLE) {
            reject(new Error('Connection failed'));
          } else {
            setTimeout(checkState, 100);
          }
        };
        checkState();
      });
    }

    // Reject if in DISCONNECTING phase
    if (currentPhase === ConnectionPhase.DISCONNECTING) {
      throw new Error('Cannot connect while disconnecting - wait for IDLE state');
    }

    // Only IDLE state can transition to CONNECTING
    if (!this.canTransitionTo(ConnectionPhase.CONNECTING)) {
      throw new Error(`Cannot connect from ${currentPhase} state`);
    }

    // Start new connection session
    const sessionId = this.nextSessionId++;
    this.connectionSession.sessionId = sessionId;
    this.transitionTo(ConnectionPhase.CONNECTING, `User connect() - sessionId=${sessionId}`);

    try {
      await this._doConnect(sessionId);
      this.transitionTo(ConnectionPhase.CONNECTED, 'All sessions ready');
      dbg(`Connection session ${sessionId} established successfully`);
    } catch (err) {
      // Clean up abort handler
      this.abortHandlers.delete(sessionId);
      // Transition to IDLE on failure
      this.transitionTo(ConnectionPhase.IDLE, `Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * Internal connection implementation
   * Uses local promises to avoid race conditions
   * Uses phased timeout: 30s for overall, 10s for sub-sessions after login
   * @param sessionId - Unique session ID to prevent race conditions
   */
  private async _doConnect(sessionId: number) {
    const { loginReady, civReady, audioReady, cleanup } = this.createReadyPromises(sessionId);

    try {
      // Reset all session states to initial values
      // This is CRITICAL for reconnection after radio restart
      // Without this, the radio won't recognize our old localId/remoteId/tokens
      dbg('Resetting all session states before connection...');
      this.sess.resetState();
      this.civSess.resetState();
      this.audioSess.resetState();

      // Ensure all session sockets are open (critical for reconnection after disconnect)
      this.sess.open();
      this.civSess.open();
      this.audioSess.open();

      this.sess.startAreYouThere();

      // Phase 1: Wait for login (protected by overall 30s timeout from connectWithTimeout)
      await loginReady;
      dbg('Login complete, waiting for CIV/Audio sub-sessions...');

      // Phase 2: Wait for CIV/Audio with shorter timeout (10s)
      // If radio doesn't respond to AreYouThere, fail fast instead of waiting full 30s
      const SUB_SESSION_TIMEOUT = 10000;
      const subSessionTimeout = new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`CIV/Audio sessions timeout after ${SUB_SESSION_TIMEOUT}ms - radio not responding to AreYouThere`));
        }, SUB_SESSION_TIMEOUT);
      });

      await Promise.race([
        Promise.all([civReady, audioReady]),
        subSessionTimeout
      ]);

      dbg('All sessions ready (login + civ + audio)');

      // Start unified connection monitoring
      this.startUnifiedMonitoring();
      dbg('Unified connection monitoring started');
    } finally {
      cleanup();
    }
  }

  /**
   * Create local promises for connection readiness
   * This avoids race conditions with instance variables
   * @param sessionId - Connection session ID for abort handler tracking
   */
  private createReadyPromises(sessionId: number) {
    let resolveLogin: () => void;
    let resolveCiv: () => void;
    let resolveAudio: () => void;
    let rejectLogin: (reason: Error) => void;
    let rejectCiv: (reason: Error) => void;
    let rejectAudio: (reason: Error) => void;

    const loginReady = new Promise<void>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    const civReady = new Promise<void>((resolve, reject) => {
      resolveCiv = resolve;
      rejectCiv = reject;
    });
    const audioReady = new Promise<void>((resolve, reject) => {
      resolveAudio = resolve;
      rejectAudio = reject;
    });

    // Store abort handler bound to this specific sessionId
    // This prevents race conditions when multiple connection attempts overlap
    const abortHandler = (reason: DisconnectReason, silent: boolean) => {
      const message = getDisconnectMessage(reason);
      dbg(`Aborting connection session ${sessionId}: ${message} (silent=${silent})`);

      // Create a single error instance to be shared across all rejections
      const error = new ConnectionAbortedError(
        reason,
        sessionId,
        this.connectionSession.phase
      );

      // IMPORTANT: Always reject promises to unblock waiting code
      // The "silent" flag only affects whether errors propagate to user code,
      // but internally we must settle the promise to prevent hanging
      dbg(`${silent ? 'Silent' : 'Normal'} abort - rejecting login promise for session ${sessionId}`);

      // Defensive error handling: wrap reject calls in try-catch to prevent
      // synchronous errors from propagating if promises are already settled
      // Only reject one promise to avoid duplicate errors
      try {
        rejectLogin(error);
      } catch (err) {
        dbg(`Warning: Failed to reject loginReady promise: ${err}`);
      }

      // Don't reject civ and audio promises separately - they'll be cleaned up
      // This prevents the "3x User disconnect()" log spam
    };
    this.abortHandlers.set(sessionId, abortHandler);

    // Track promise states for defensive cleanup
    let loginResolved = false;
    let civResolved = false;
    let audioResolved = false;

    // Temporary event listeners (local scope)
    const onLogin = (res: LoginResult) => {
      if (res.ok) {
        dbg(`Login ready - resolving local loginReady promise (sessionId=${sessionId})`);
        loginResolved = true;
        resolveLogin();
      }
    };
    const onCivReady = () => {
      dbg(`CIV ready - resolving local civReady promise (sessionId=${sessionId})`);
      civResolved = true;
      resolveCiv();
    };
    const onAudioReady = () => {
      dbg(`Audio ready - resolving local audioReady promise (sessionId=${sessionId})`);
      audioResolved = true;
      resolveAudio();
    };

    this.ev.once('login', onLogin);
    this.ev.once('_civReady', onCivReady);
    this.ev.once('_audioReady', onAudioReady);

    return {
      loginReady,
      civReady,
      audioReady,
      cleanup: () => {
        // Defensive cleanup: wrap each cleanup step in try-catch
        // to ensure all cleanup steps execute even if one fails
        dbg(`Cleaning up connection session ${sessionId} (login=${loginResolved}, civ=${civResolved}, audio=${audioResolved})`);

        // Remove abort handler for this specific sessionId
        try {
          this.abortHandlers.delete(sessionId);
        } catch (err) {
          dbg(`Warning: Failed to delete abort handler: ${err}`);
        }

        // Remove event listeners - wrap each in try-catch
        try {
          this.ev.off('login', onLogin);
        } catch (err) {
          dbg(`Warning: Failed to remove login listener: ${err}`);
        }

        try {
          this.ev.off('_civReady', onCivReady);
        } catch (err) {
          dbg(`Warning: Failed to remove civReady listener: ${err}`);
        }

        try {
          this.ev.off('_audioReady', onAudioReady);
        } catch (err) {
          dbg(`Warning: Failed to remove audioReady listener: ${err}`);
        }

        dbg(`Cleanup complete for session ${sessionId}`);
      }
    };
  }

  /**
   * Start unified connection monitoring
   * Monitors all three sessions from a single timer to avoid race conditions
   * @private
   */
  private startUnifiedMonitoring() {
    this.stopUnifiedMonitoring();

    this.monitorTimer = setInterval(() => {
      // Only monitor when CONNECTED (not during CONNECTING, RECONNECTING, DISCONNECTING, or IDLE)
      if (this.connectionSession.phase !== ConnectionPhase.CONNECTED) {
        return;
      }

      const now = Date.now();
      const sessions = [
        { sess: this.sess, type: SessionType.CONTROL },
        { sess: this.civSess, type: SessionType.CIV },
        { sess: this.audioSess, type: SessionType.AUDIO }
      ];

      // Check each session for timeout
      for (const { sess, type } of sessions) {
        if (sess['destroyed']) continue; // Skip destroyed sessions

        const timeSinceLastData = now - sess.lastReceivedTime;
        if (timeSinceLastData > this.monitorConfig.timeout) {
          dbg(`${type} session timeout detected (${timeSinceLastData}ms since last data)`);
          this.handleConnectionLost(type, timeSinceLastData);
          return; // Only handle one timeout at a time to avoid duplicate reconnect triggers
        }
      }
    }, this.monitorConfig.checkInterval);
  }

  /**
   * Stop unified connection monitoring
   * @private
   */
  private stopUnifiedMonitoring() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  /**
   * Disconnect from the rig
   * @param options - Optional disconnect options (reason, silent mode)
   * @returns Promise that resolves when disconnect is complete
   */
  async disconnect(options?: DisconnectOptions | DisconnectReason): Promise<void> {
    // Support both object and enum parameter for backward compatibility
    const opts = typeof options === 'string'
      ? { reason: options, silent: false }
      : { reason: DisconnectReason.USER_REQUEST, silent: false, ...options };

    const reason: DisconnectReason = opts.reason ?? DisconnectReason.USER_REQUEST;
    const silent = opts.silent ?? false;
    const currentPhase = this.connectionSession.phase;

    dbg(`disconnect() called with reason=${reason}, silent=${silent}, currentPhase=${currentPhase}`);

    // If already disconnecting or idle, avoid duplicate work
    if (currentPhase === ConnectionPhase.DISCONNECTING) {
      dbg('disconnect() called but already DISCONNECTING - waiting for completion');
      // Wait for transition to IDLE
      return new Promise<void>((resolve) => {
        const checkState = () => {
          if (this.connectionSession.phase === ConnectionPhase.IDLE) {
            resolve();
          } else {
            setTimeout(checkState, 100);
          }
        };
        checkState();
      });
    }

    if (currentPhase === ConnectionPhase.IDLE) {
      dbg('disconnect() called but already IDLE - no-op');
      return;
    }

    // Abort any ongoing connection attempts - wrap in try-catch for defensive programming
    const currentSessionId = this.connectionSession.sessionId;
    if (currentPhase === ConnectionPhase.CONNECTING || currentPhase === ConnectionPhase.RECONNECTING) {
      try {
        dbg(`Aborting ongoing connection attempt (sessionId=${currentSessionId})`);
        this.abortConnectionAttempt(currentSessionId, reason, silent);
      } catch (abortErr) {
        // Log but continue - abort failure shouldn't prevent disconnect
        const errMsg = abortErr instanceof Error ? abortErr.message : String(abortErr);
        dbg(`Warning: Failed to abort connection attempt: ${errMsg} - continuing with disconnect`);
      }
    }

    // Transition to DISCONNECTING state
    const transitionReason = getDisconnectMessage(reason);
    this.transitionTo(ConnectionPhase.DISCONNECTING, transitionReason);

    try {
      // 1. Stop all timers first to prevent interference
      this.stopUnifiedMonitoring(); // Stop unified monitoring
      if (this.tokenTimer) { clearInterval(this.tokenTimer); this.tokenTimer = undefined; }
      this.stopMeterPolling();
      this.sess.stopTimers();
      if (this.civSess) this.civSess.stopTimers();
      if (this.audioSess) this.audioSess.stopTimers();

      // 2. Send DELETE token packet
      try {
        const del = TokenPacket.build(0, this.sess.localId, this.sess.remoteId, TokenType.DELETE, this.sess.innerSeq, this.sess.localToken, this.sess.rigToken);
        this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
        this.sess.sendTracked(del);
      } catch (err) {
        dbg('Failed to send DELETE token packet:', err);
        // Continue with disconnect even if this fails
      }

      // 3. Send CMD_DISCONNECT to all sessions
      try {
        this.sess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.sess.localId, this.sess.remoteId));
        if (this.civSess) {
          this.civ.sendOpenClose(false);
          this.civSess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.civSess.localId, this.civSess.remoteId));
        }
        if (this.audioSess) {
          this.audioSess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.audioSess.localId, this.audioSess.remoteId));
        }
      } catch (err) {
        dbg('Failed to send DISCONNECT packets:', err);
        // Continue with disconnect even if this fails
      }

      // 4. Wait 200ms to ensure UDP packets are sent before closing sockets
      await new Promise(resolve => setTimeout(resolve, 200));

      // 5. Stop streams and close sockets
      this.civ.stop();
      this.audio.stop(); // Stop continuous audio transmission
      this.sess.close();
      if (this.civSess) this.civSess.close();
      if (this.audioSess) this.audioSess.close();

    } catch (err) {
      dbg('Error during disconnect:', err);
      // Continue to IDLE state even if there were errors
    } finally {
      // Always transition to IDLE at the end
      this.transitionTo(ConnectionPhase.IDLE, 'Disconnect complete');
    }
  }

  sendCiv(data: Buffer) { this.civ.sendCivData(data); }

  async enableScope(): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeDisplay(ctrAddr, rigAddr, true));
    this.sendCiv(IcomScopeCommands.setScopeDataOutput(ctrAddr, rigAddr, true));
  }

  async disableScope(): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeDataOutput(ctrAddr, rigAddr, false));
    this.sendCiv(IcomScopeCommands.setScopeDisplay(ctrAddr, rigAddr, false));
  }

  async readScopeSpan(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomScopeSpanInfo | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const receiver = options?.receiver ?? 0;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomScopeCommands.readScopeSpan(ctrAddr, rigAddr, receiver);
    const resp = await this.waitForCivFrame(
      `scope:0x27:0x15:${receiver}`,
      (frame) => IcomControl.matchCommandFrame(frame, 0x27, [0x15, receiver], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    if (!resp || resp.length < 13) {
      return null;
    }

    const encodedSpanHz = parseIcomBcdFreqLE(resp.subarray(7, 12));
    return {
      receiver,
      spanHz: encodedSpanHz * 2,
    };
  }

  async setScopeSpan(spanHz: number, options?: { receiver?: 0 | 1 }): Promise<void> {
    const receiver = options?.receiver ?? 0;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeSpan(ctrAddr, rigAddr, spanHz, receiver));
  }

  async readScopeMode(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomScopeModeInfo | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const receiver = options?.receiver ?? 0;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomScopeCommands.readScopeMode(ctrAddr, rigAddr, receiver);
    const resp = await this.waitForCivFrame(
      `scope:0x27:0x14:${receiver}`,
      (frame) => IcomControl.matchCommandFrame(frame, 0x27, [0x14, receiver], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    if (!resp || resp.length < 9) {
      return null;
    }

    const mode = resp[7] as 0 | 1 | 2 | 3;
    return {
      receiver,
      mode,
      modeName: modeCodeToName(mode),
    };
  }

  async setScopeMode(mode: IcomScopeMode | 0 | 1 | 2 | 3, options?: { receiver?: 0 | 1 }): Promise<void> {
    const receiver = options?.receiver ?? 0;
    const modeCode = typeof mode === 'string' ? modeNameToCode(mode) : mode;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeMode(ctrAddr, rigAddr, modeCode, receiver));
  }

  async readScopeEdge(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomScopeEdgeInfo | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const receiver = options?.receiver ?? 0;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomScopeCommands.readScopeEdge(ctrAddr, rigAddr, receiver);
    const resp = await this.waitForCivFrame(
      `scope:0x27:0x16:${receiver}`,
      (frame) => IcomControl.matchCommandFrame(frame, 0x27, [0x16, receiver], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    if (!resp || resp.length < 9) {
      return null;
    }

    return {
      receiver,
      edgeSlot: resp[7],
    };
  }

  async setScopeEdge(edgeSlot: number, options?: { receiver?: 0 | 1 }): Promise<void> {
    const receiver = options?.receiver ?? 0;
    const slots = this.activeProfile.scopeEdgeSlots;
    const maxSlot = slots.length ? Math.max(...slots) : 4;
    const safeEdgeSlot = Math.max(1, Math.min(maxSlot, Math.trunc(edgeSlot)));
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeEdge(ctrAddr, rigAddr, safeEdgeSlot, receiver));
  }

  async readScopeFixedEdge(rangeId: number, edgeSlot: number, options?: QueryOptions): Promise<IcomScopeFixedEdgeInfo | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomScopeCommands.readScopeFixedEdge(ctrAddr, rigAddr, rangeId, edgeSlot);
    const resp = await this.waitForCivFrame(
      `scope:0x27:0x1e:${rangeId}:${edgeSlot}`,
      (frame) => IcomControl.matchCommandFrame(frame, 0x27, [0x1e, rangeId, edgeSlot], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    if (!resp || resp.length < 18) {
      return null;
    }

    return {
      rangeId,
      edgeSlot,
      lowHz: parseIcomBcdFreqLE(resp.subarray(8, 13)),
      highHz: parseIcomBcdFreqLE(resp.subarray(13, 18)),
    };
  }

  async setScopeFixedEdge(options: { rangeId?: number; edgeSlot?: number; lowHz: number; highHz: number }): Promise<IcomScopeFixedEdgeInfo> {
    const rangeId = options.rangeId ?? await this.resolveScopeFrequencyRangeId();
    const edgeInfo = options.edgeSlot
      ? { edgeSlot: options.edgeSlot }
      : await this.readScopeEdge({ receiver: 0, timeout: 3000 });
    const edgeSlot = edgeInfo?.edgeSlot ?? 1;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomScopeCommands.setScopeFixedEdge(ctrAddr, rigAddr, rangeId, edgeSlot, options.lowHz, options.highHz));
    return {
      rangeId,
      edgeSlot,
      lowHz: options.lowHz,
      highHz: options.highHz,
    };
  }

  async resolveScopeFrequencyRangeId(frequencyHz?: number): Promise<number> {
    const targetFrequency = frequencyHz ?? await this.readOperatingFrequency({ timeout: 3000 });
    if (!targetFrequency) {
      throw new Error('Unable to resolve scope frequency range without operating frequency');
    }
    const matched = this.activeProfile.scopeRanges.find((range) => targetFrequency >= range.lowHz && targetFrequency < range.highHz);
    if (!matched) {
      throw new Error(`No scope frequency range matches ${targetFrequency} Hz`);
    }
    return matched.rangeId;
  }

  getScopeSupportedEdgeSlots(): number[] {
    return [...this.activeProfile.scopeEdgeSlots];
  }

  async getSpectrumDisplayState(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomSpectrumDisplayState> {
    const receiver = options?.receiver ?? 0;
    const [modeInfo, spanInfo, edgeInfo] = await Promise.all([
      this.readScopeMode({ ...options, receiver }),
      this.readScopeSpan({ ...options, receiver }),
      this.readScopeEdge({ ...options, receiver }),
    ]);
    let fixedEdgeInfo: IcomScopeFixedEdgeInfo | null = null;
    if (modeInfo?.modeName === 'fixed' || modeInfo?.modeName === 'scroll-fixed') {
      try {
        const rangeId = await this.resolveScopeFrequencyRangeId();
        fixedEdgeInfo = await this.readScopeFixedEdge(rangeId, edgeInfo?.edgeSlot ?? 1, options);
      } catch (_) {
        fixedEdgeInfo = null;
      }
    }

    return {
      mode: modeInfo?.modeName ?? null,
      modeCode: modeInfo?.mode ?? null,
      spanHz: spanInfo?.spanHz ?? (fixedEdgeInfo ? fixedEdgeInfo.highHz - fixedEdgeInfo.lowHz : null),
      edgeSlot: edgeInfo?.edgeSlot ?? null,
      edgeLowHz: fixedEdgeInfo?.lowHz ?? null,
      edgeHighHz: fixedEdgeInfo?.highHz ?? null,
      supportedModes: ['center', 'fixed', 'scroll-center', 'scroll-fixed'],
      supportedSpans: [...DEFAULT_SCOPE_SPANS_HZ],
      supportedEdgeSlots: this.getScopeSupportedEdgeSlots(),
      supportsFixedEdges: this.activeProfile.scopeRanges.length > 0,
      supportsEdgeSlotSelection: this.activeProfile.scopeEdgeSlots.length > 0,
    };
  }

  async configureSpectrumDisplay(config: IcomSpectrumDisplayConfig = {}): Promise<IcomSpectrumDisplayState> {
    const receiver = config.receiver ?? 0;
    if (config.mode !== undefined) {
      await this.setScopeMode(config.mode, { receiver });
    }
    if (config.edgeSlot !== undefined) {
      await this.setScopeEdge(config.edgeSlot, { receiver });
    }
    if (config.spanHz !== undefined && (!config.mode || config.mode === 'center' || config.mode === 'scroll-center')) {
      await this.setScopeSpan(config.spanHz, { receiver });
    }
    if (config.edgeLowHz !== undefined && config.edgeHighHz !== undefined && (!config.mode || config.mode === 'fixed' || config.mode === 'scroll-fixed')) {
      await this.setScopeFixedEdge({
        rangeId: config.rangeId,
        edgeSlot: config.edgeSlot,
        lowHz: config.edgeLowHz,
        highHz: config.edgeHighHz,
      });
    }
    return this.getSpectrumDisplayState({ receiver, timeout: 3000 });
  }

  async getSpectrumMode(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomScopeMode | null> {
    return (await this.readScopeMode(options))?.modeName ?? null;
  }

  async setSpectrumMode(mode: IcomScopeMode, options?: { receiver?: 0 | 1 }): Promise<void> {
    await this.setScopeMode(mode, options);
  }

  async getSpectrumSpan(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<number | null> {
    return (await this.readScopeSpan(options))?.spanHz ?? null;
  }

  async setSpectrumSpan(spanHz: number, options?: { receiver?: 0 | 1 }): Promise<void> {
    await this.setScopeSpan(spanHz, options);
  }

  async getSpectrumEdgeSlot(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<number | null> {
    return (await this.readScopeEdge(options))?.edgeSlot ?? null;
  }

  async setSpectrumEdgeSlot(edgeSlot: number, options?: { receiver?: 0 | 1 }): Promise<void> {
    await this.setScopeEdge(edgeSlot, options);
  }

  async getSpectrumFixedEdges(options?: QueryOptions & { receiver?: 0 | 1; rangeId?: number; edgeSlot?: number }): Promise<{ lowHz: number; highHz: number; rangeId: number; edgeSlot: number } | null> {
    const rangeId = options?.rangeId ?? await this.resolveScopeFrequencyRangeId();
    const edgeSlot = options?.edgeSlot ?? await this.getSpectrumEdgeSlot(options) ?? 1;
    const info = await this.readScopeFixedEdge(rangeId, edgeSlot, options);
    if (!info) {
      return null;
    }
    return info;
  }

  async setSpectrumFixedEdges(options: { rangeId?: number; edgeSlot?: number; lowHz: number; highHz: number }): Promise<{ lowHz: number; highHz: number; rangeId: number; edgeSlot: number }> {
    return this.setScopeFixedEdge(options);
  }

  async waitForScopeFrame(options?: QueryOptions) {
    const timeoutMs = options?.timeout ?? 3000;
    return this.scope.waitForScopeFrame(timeoutMs);
  }

  /**
   * Set PTT (Push-To-Talk) state
   * @param on - true to key transmitter, false to unkey
   */
  async setPtt(on: boolean): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    // Send CIV PTT command
    const frame = IcomRigCommands.setPTT(ctrAddr, rigAddr, on);
    this.sendCiv(frame);
    // Set audio PTT flag (like Java: audioUdp.isPttOn = on)
    this.audio.isPttOn = on;
    // Start/stop meter polling to match Java behavior
    if (on) {
      this.startMeterPolling();
    } else {
      this.stopMeterPolling();
    }
    // Add trailing silence when PTT off (like Java implementation)
    if (!on) {
      // Add 5 trailing silence frames before clearing queue
      const silence = new Int16Array(240); // TX_BUFFER_SIZE = 240
      for (let i = 0; i < 5; i++) {
        this.audio.queue.push(silence);
      }
    }
  }

  /**
   * Set operating frequency
   * @param hz - Frequency in Hz
   */
  async setFrequency(hz: number): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const bcdBytes = this.activeProfile.frequencyBcdBytes(hz);
    const frame = this.activeProfile.supportsX25X26
      ? IcomRigCommands.setSelectedFrequency(ctrAddr, rigAddr, hz, bcdBytes, 0)
      : IcomRigCommands.setFrequency(ctrAddr, rigAddr, hz, bcdBytes);
    this.sendCiv(frame);
  }

  /**
   * Set operating mode
   * @param mode - Operating mode (LSB, USB, AM, CW, RTTY, FM, WFM, CW_R, RTTY_R, DV)
   * @param options - Mode options (dataMode for digital modes like USB-D)
   * @example
   * // Set USB mode
   * await rig.setMode('USB');
   * // Set USB-D (data mode) for FT8
   * await rig.setMode('USB', { dataMode: true });
   */
  async setMode(mode: IcomMode | number, options?: SetModeOptions): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const modeCode = typeof mode === 'string' ? getModeCode(mode) : mode;
    const filter = options?.filter ?? this.lastFilter ?? this.activeProfile.defaultFilter;

    if (this.activeProfile.supportsX25X26 && this.activeProfile.modeWithFilter) {
      this.sendCiv(IcomRigCommands.setSelectedMode(ctrAddr, rigAddr, modeCode, !!options?.dataMode, filter, 0));
      return;
    }

    if (options?.dataMode && this.activeProfile.dataModeSupported) {
      this.sendCiv(IcomRigCommands.setOperationDataMode(ctrAddr, rigAddr, modeCode, filter));
    } else {
      this.sendCiv(IcomRigCommands.setMode(ctrAddr, rigAddr, modeCode, filter));
    }
  }

  /**
   * Read current operating frequency
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Frequency in Hz, or null if timeout/error
   * @example
   * const hz = await rig.readOperatingFrequency({ timeout: 5000 });
   * console.log(`Frequency: ${hz} Hz`);
   */
  async readOperatingFrequency(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const useX25 = this.activeProfile.supportsX25X26;
    const req = useX25
      ? IcomRigCommands.readSelectedFrequency(ctrAddr, rigAddr, 0)
      : IcomRigCommands.readOperatingFrequency(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      useX25 ? 'freq:0x25:0' : 'freq:0x03',
      (frame) => useX25
        ? IcomControl.matchCommandFrame(frame, CIV.C_SEND_SEL_FREQ, [0x00], ctrAddr, rigAddr)
        : IcomControl.matchCommandFrame(frame, CIV.C_RD_FREQ, [], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    return IcomControl.parseFrequencyReply(resp, useX25 ? 1 : 0);
  }

  /**
   * Read current operating mode and filter
   * @returns { mode: number, filter?: number } or null
   */
  async readOperatingMode(options?: QueryOptions): Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string; dataMode?: boolean } | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const useX26 = this.activeProfile.supportsX25X26 && this.activeProfile.modeWithFilter;
    const req = useX26 ? IcomRigCommands.readSelectedMode(ctrAddr, rigAddr, 0) : IcomRigCommands.readOperatingMode(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      useX26 ? 'mode:0x26:0' : 'mode:0x04',
      (frame) => useX26
        ? IcomControl.matchCommandFrame(frame, CIV.C_SEND_SEL_MODE, [0x00], ctrAddr, rigAddr)
        : IcomControl.matchCommandFrame(frame, CIV.C_RD_MODE, [], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;

    const mode = useX26 ? resp[6] : resp[5];
    const dataMode = useX26 ? resp[7] !== 0x00 : undefined;
    const filter = useX26 ? resp[8] : (resp.length > 6 ? resp[6] : undefined);
    if (mode === undefined) return null;
    if (filter === 1 || filter === 2 || filter === 3) this.lastFilter = filter;
    const { getModeString, getFilterString } = await import('./IcomConstants');
    const modeName = getModeString(mode);
    const filterName = getFilterString(filter);
    return { mode, filter, modeName, filterName, dataMode };
  }

  /**
   * Read current transmit frequency (when TX)
   */
  async readTransmitFrequency(options?: QueryOptions): Promise<number | null> {
    if (!this.activeProfile.supportsX1C03TxFreq) return null;
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readTransmitFrequency(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'freq:0x1c:0x03',
      (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_PTT, [CIV.S_RD_TX_FREQ], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    return IcomControl.parseFrequencyReply(resp, 1);
  }

  async readPtt(options?: QueryOptions): Promise<boolean | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readPTT(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'ptt:0x1c:0x00',
      (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_PTT, [CIV.S_PTT], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp || resp.length < 7) return null;
    return resp[6] !== 0x00;
  }

  /** Read transceiver state (TX/RX) using standard Hamlib-aligned PTT status. */
  async readTransceiverState(options?: QueryOptions): Promise<'TX' | 'RX' | 'UNKNOWN' | null> {
    const ptt = await this.readPtt(options);
    if (ptt === null) return null;
    return ptt ? 'TX' : 'RX';
  }

  /**
   * Read band edge data (0x02). Format may vary by rig; returns raw data bytes after command.
   */
  async readBandEdges(options?: QueryOptions): Promise<Buffer | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readBandEdges(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'band:0x02',
      (frame) => IcomControl.matchCommandFrame(frame, 0x02, [], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Return raw payload bytes after command
    return Buffer.from(resp.subarray(5, resp.length - 1));
  }

  /**
   * Read SWR (Standing Wave Ratio) meter
   * @param options - Query options (timeout in ms, default 3000)
   * @returns SWR reading with raw value, calculated SWR, and alert status
   * @example
   * const swr = await rig.readSWR({ timeout: 2000 });
   * if (swr) {
   *   console.log(`SWR: ${swr.swr.toFixed(2)} ${swr.alert ? '⚠️ HIGH' : '✓'}`);
   * }
   */
  async readSWR(options?: QueryOptions): Promise<SwrReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getSWRState(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x12',
      (frame) => IcomControl.isMeterReply(frame, 0x12, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      swr: interpolateCalibration(raw, this.activeProfile.calibrations.swr),
      alert: interpolateCalibration(raw, this.activeProfile.calibrations.swr) >= 3.0
    };
  }

  /**
   * Read ALC (Automatic Level Control) meter
   * @param options - Query options (timeout in ms, default 3000)
   * @returns ALC reading with raw value, percent, and alert status
   * @example
   * const alc = await rig.readALC({ timeout: 2000 });
   * if (alc) {
   *   console.log(`ALC: ${alc.percent.toFixed(1)}% ${alc.alert ? '⚠️ HIGH' : '✓'}`);
   * }
   */
  async readALC(options?: QueryOptions): Promise<AlcReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getALCState(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x13',
      (frame) => IcomControl.isMeterReply(frame, 0x13, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      percent: interpolateCalibration(raw, this.activeProfile.calibrations.alc),
      alert: interpolateCalibration(raw, this.activeProfile.calibrations.alc) > 100
    };
  }

  /**
   * Get WLAN connector audio level setting
   * @param options - Query options (timeout in ms, default 3000)
   * @returns WLAN level reading with raw value and percent
   * @example
   * const level = await rig.getConnectorWLanLevel({ timeout: 2000 });
   * if (level) {
   *   console.log(`WLAN Level: ${level.percent.toFixed(1)}%`);
   * }
   */
  async getConnectorWLanLevel(options?: QueryOptions): Promise<WlanLevelReading | null> {
    const ext = this.activeProfile.vendorExtensions.connectorWlanLevel;
    if (!ext) return null;
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getConnectorWLanLevel(ctrAddr, rigAddr, ext.subext);
    const resp = await this.waitForCivFrame(
      `ext:0x${ext.command.toString(16)}:0x${ext.subcmd.toString(16)}:${ext.subext.join('.')}`,
      (frame) => IcomControl.matchCommandFrame(frame, ext.command, [ext.subcmd, ...ext.subext], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractTrailingBcd(resp, ext.dataBytes);
    if (raw === null) return null;

    return {
      raw,
      percent: (raw / METER_THRESHOLDS.WLAN_LEVEL_MAX) * 100
    };
  }

  /**
   * Read S-meter (signal strength) level (CI-V 0x15/0x02)
   * Returns complete reading with S-units, dB, and dBm conversion
   *
   * @param options - Query options (timeout)
   * @returns S-meter reading with physical units, or null if timeout
   *
   * @example
   * ```typescript
   * const reading = await rig.getLevelMeter();
   * if (reading) {
   *   console.log(reading.formatted);  // "S9+10dB"
   *   console.log(reading.sUnits);     // 9.99
   *   console.log(reading.dBm);        // -63.08
   * }
   * ```
   */
  async getLevelMeter(options?: QueryOptions): Promise<LevelMeterReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getLevelMeter(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x02',
      (frame) => IcomControl.isMeterReply(frame, 0x02, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    const data = resp.subarray(6, resp.length - 1);
    if (data.length === 0) return null;
    const raw = data[data.length - 1] & 0xff; // use low byte as 0-255 level

    return rawToSMeter(raw, this.activeProfile.calibrations.sMeterModel);
  }

  /**
   * Set WLAN connector audio level
   * @param level - Audio level (0-255)
   */
  async setConnectorWLanLevel(level: number): Promise<void> {
    const ext = this.activeProfile.vendorExtensions.connectorWlanLevel;
    if (!ext) {
      throw new UnsupportedCommandError({ modelId: this.getProfileModelId(), commandName: 'setConnectorWLanLevel', civCommand: '0x1a/0x05', reason: 'No vendor WLAN level extension for active profile' });
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setConnectorWLanLevel(ctrAddr, rigAddr, level, ext.subext));
  }

  async getUsbAfLevel(options?: QueryOptions): Promise<WlanLevelReading | null> {
    const ext = this.activeProfile.extParams.usbAfLevel;
    if (!ext) return null;
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getUsbAfLevel(ctrAddr, rigAddr, ext.subext);
    const resp = await this.waitForCivFrame(
      `ext:0x${ext.command.toString(16)}:0x${ext.subcmd.toString(16)}:${ext.subext.join('.')}`,
      (frame) => IcomControl.matchCommandFrame(frame, ext.command, [ext.subcmd, ...ext.subext], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    const raw = IcomControl.extractTrailingBcd(resp, ext.dataBytes);
    if (raw === null) return null;
    return { raw, percent: (raw / 255) * 100 };
  }

  async setUsbAfLevel(level: number): Promise<void> {
    const ext = this.activeProfile.extParams.usbAfLevel;
    if (!ext) {
      throw new UnsupportedCommandError({ modelId: this.getProfileModelId(), commandName: 'setUsbAfLevel', civCommand: '0x1a/0x05', reason: 'No USB AF level extension for active profile' });
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const raw = Math.max(0, Math.min(255, Math.round(level)));
    this.sendCiv(IcomRigCommands.setUsbAfLevel(ctrAddr, rigAddr, raw, ext.subext));
  }

  /**
   * Set connector data routing mode
   * @param mode - Data routing mode (MIC, ACC, USB, WLAN)
   * @example
   * // Route audio to WLAN
   * await rig.setConnectorDataMode('WLAN');
   */
  async setConnectorDataMode(mode: ConnectorDataMode | number): Promise<void> {
    const ext = this.activeProfile.vendorExtensions.connectorDataMode;
    if (!ext) {
      throw new UnsupportedCommandError({ modelId: this.getProfileModelId(), commandName: 'setConnectorDataMode', civCommand: '0x1a/0x05', reason: 'No vendor connector data-mode extension for active profile' });
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const modeCode = typeof mode === 'string' ? getConnectorModeCode(mode) : mode;
    this.sendCiv(IcomRigCommands.setConnectorDataMode(ctrAddr, rigAddr, modeCode, ext.subext));
  }

  /**
   * ==============================
   * Antenna Tuner (ATU) Operations
   * ==============================
   */

  /**
   * Read antenna tuner status (CI-V 0x1C/0x01)
   * 00=OFF, 01=ON, 02=TUNING
   */
  async readTunerStatus(options?: QueryOptions): Promise<TunerStatusReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getTunerStatus(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'tuner:0x1c:0x01',
      (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_PTT, [CIV.S_ANT_TUN], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Expect FE FE [ctr] [rig] 0x1C 0x01 [status] FD
    const raw = resp.length > 6 ? (resp[6] & 0xff) : undefined;
    if (raw === undefined) return null;
    const state: TunerState = raw === 0x00 ? 'OFF' : raw === 0x01 ? 'ON' : raw === 0x02 ? 'TUNING' : 'OFF';
    return { raw, state };
  }

  /**
   * Enable or disable internal antenna tuner (CI-V 0x1C/0x01)
   * @param enabled true to enable, false to disable
   */
  async setTunerEnabled(enabled: boolean): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setTunerEnabled(ctrAddr, rigAddr, enabled));
  }

  /**
   * Start a manual tuning cycle (same as [TUNE] key) (CI-V 0x1C/0x01/0x02)
   */
  async startManualTune(): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.startManualTune(ctrAddr, rigAddr));
  }

  // ============================================================================
  // 0x14 Level API — AF Gain, SQL, RF Power, MIC Gain, NB Level, NR Level
  // ============================================================================

  /** Get AF (audio output) gain. Returns 0.0–1.0, or null on timeout. */
  async getAFGain(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(0x01, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set AF (audio output) gain. Value 0.0–1.0. */
  setAFGain(value: number): void {
    this.write0x14Level(0x01, value);
  }

  /** Get squelch level. Returns 0.0–1.0, or null on timeout. */
  async getSQL(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(0x03, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set squelch level. Value 0.0–1.0. */
  setSQL(value: number): void {
    this.write0x14Level(0x03, value);
  }

  /** Get RF transmit power. Returns 0.0–1.0, or null on timeout. */
  async getRFPower(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(0x0a, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set RF transmit power. Value 0.0–1.0. */
  setRFPower(value: number): void {
    this.write0x14Level(0x0a, value);
  }

  /** Get microphone gain. Returns 0.0–1.0, or null on timeout. */
  async getMicGain(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(CIV.S_LVL_MICGAIN, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set microphone gain. Value 0.0–1.0. */
  setMicGain(value: number): void {
    this.write0x14Level(CIV.S_LVL_MICGAIN, value);
  }

  /** Get break-in delay. Returns 0.0–1.0, or null on timeout. */
  async getBreakInDelay(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(CIV.S_LVL_BKINDL, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set break-in delay. Value 0.0–1.0. */
  setBreakInDelay(value: number): void {
    this.write0x14Level(CIV.S_LVL_BKINDL, value);
  }

  /** Get noise blanker level. 0.0 = off, >0.0 = on with strength. */
  async getNBLevel(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(0x12, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set noise blanker level. Value 0.0 (off) – 1.0. */
  setNBLevel(value: number): void {
    this.write0x14Level(0x12, value);
  }

  /** Get noise reduction level. 0.0 = off, >0.0 = on with strength. */
  async getNRLevel(options?: QueryOptions): Promise<LevelReading | null> {
    const v = await this.read0x14Level(CIV.S_LVL_NR, options);
    if (v === null) return null;
    return { raw: Math.round(v * 255), normalized: v };
  }

  /** Set noise reduction level. Value 0.0 (off) – 1.0. */
  setNRLevel(value: number): void {
    this.write0x14Level(CIV.S_LVL_NR, value);
  }

  /**
   * Read squelch status (noise/signal gate state)
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Squelch status with raw value and boolean state
   * @example
   * const status = await rig.readSquelchStatus({ timeout: 2000 });
   * if (status) {
   *   console.log(`Squelch: ${status.isOpen ? 'OPEN' : 'CLOSED'}`);
   * }
   */
  async readSquelchStatus(options?: QueryOptions): Promise<SquelchStatusReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getSquelchStatus(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x01',
      (frame) => IcomControl.isMeterReply(frame, 0x01, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      isOpen: raw === 0x0001
    };
  }

  /**
   * Read audio squelch state
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Audio squelch status with raw value and boolean state
   * @example
   * const squelch = await rig.readAudioSquelch({ timeout: 2000 });
   * if (squelch) {
   *   console.log(`Audio Squelch: ${squelch.isOpen ? 'OPEN' : 'CLOSED'}`);
   * }
   */
  async readAudioSquelch(options?: QueryOptions): Promise<AudioSquelchReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getAudioSquelch(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x05',
      (frame) => IcomControl.isMeterReply(frame, 0x05, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      isOpen: raw === 0x0001
    };
  }

  /**
   * Read OVF (ADC overload) status
   * @param options - Query options (timeout in ms, default 3000)
   * @returns OVF status with raw value and boolean overload flag
   * @example
   * const ovf = await rig.readOvfStatus({ timeout: 2000 });
   * if (ovf) {
   *   console.log(`ADC: ${ovf.isOverload ? '⚠️ OVERLOAD' : '✓ OK'}`);
   * }
   */
  async readOvfStatus(options?: QueryOptions): Promise<OvfStatusReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getOvfStatus(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x07',
      (frame) => IcomControl.isMeterReply(frame, 0x07, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      isOverload: raw === 0x0001
    };
  }

  /**
   * Read power output level during transmission
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Power level with raw value and percentage
   * @example
   * const power = await rig.readPowerLevel({ timeout: 2000 });
   * if (power) {
   *   console.log(`Power: ${power.percent.toFixed(1)}%`);
   * }
   */
  async readPowerLevel(options?: QueryOptions): Promise<PowerLevelReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getPowerLevel(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x11',
      (frame) => IcomControl.isMeterReply(frame, 0x11, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    const watts = interpolateCalibration(raw, this.activeProfile.calibrations.rfPowerWatts);
    const maxWatts = this.activeProfile.calibrations.rfPowerWatts[this.activeProfile.calibrations.rfPowerWatts.length - 1]?.value ?? 100;
    return {
      raw,
      percent: maxWatts > 0 ? Math.min(100, (watts / maxWatts) * 100) : 0,
      watts
    };
  }

  /**
   * Read COMP (voice compression) level during transmission
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Compression level with raw value and percentage
   * @example
   * const comp = await rig.readCompLevel({ timeout: 2000 });
   * if (comp) {
   *   console.log(`COMP: ${comp.percent.toFixed(1)}%`);
   * }
   */
  async readCompLevel(options?: QueryOptions): Promise<CompLevelReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getCompLevel(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x14',
      (frame) => IcomControl.isMeterReply(frame, 0x14, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    const db = interpolateCalibration(raw, this.activeProfile.calibrations.compDb);
    return {
      raw,
      percent: (db / 30) * 100,
      db
    };
  }

  /**
   * Read power supply voltage
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Voltage reading with raw value and volts
   * @example
   * const voltage = await rig.readVoltage({ timeout: 2000 });
   * if (voltage) {
   *   console.log(`Voltage: ${voltage.volts.toFixed(2)}V`);
   * }
   */
  async readVoltage(options?: QueryOptions): Promise<VoltageReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getVoltage(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x15',
      (frame) => IcomControl.isMeterReply(frame, 0x15, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      volts: interpolateCalibration(raw, this.activeProfile.calibrations.voltage)
    };
  }

  /**
   * Read power supply current draw
   * @param options - Query options (timeout in ms, default 3000)
   * @returns Current reading with raw value and amperes
   * @example
   * const current = await rig.readCurrent({ timeout: 2000 });
   * if (current) {
   *   console.log(`Current: ${current.amps.toFixed(2)}A`);
   * }
   */
  async readCurrent(options?: QueryOptions): Promise<CurrentReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getCurrent(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      'meter:0x15:0x16',
      (frame) => IcomControl.isMeterReply(frame, 0x16, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      amps: interpolateCalibration(raw, this.activeProfile.calibrations.current)
    };
  }

  async getFunction(name: IcomFunctionName, options?: QueryOptions): Promise<boolean | null> {
    if (!this.activeProfile.functions.includes(name)) return null;
    const ext = this.activeProfile.extParamSpecs[name];
    if (ext) {
      const value = await this.readExtParamValue(ext, `func-ext:${name}`, options);
      return value === null ? null : value !== 0;
    }
    const spec = FUNCTION_SPECS[name];
    if (!spec) return null;
    const raw = await this.readFunctionRaw(name, spec, options);
    if (raw === null) return null;
    if (name === 'SBKIN') return raw === 1;
    if (name === 'FBKIN') return raw === 2;
    return raw !== 0;
  }

  setFunction(name: IcomFunctionName, enabled: boolean): void {
    if (!this.activeProfile.functions.includes(name)) {
      throw this.unsupported(name, 'setFunction', 'Function is not enabled for active profile');
    }
    const ext = this.activeProfile.extParamSpecs[name];
    if (ext) {
      this.writeExtParamValue(ext, enabled ? 1 : 0);
      return;
    }
    const spec = FUNCTION_SPECS[name];
    if (!spec || name === 'OVF_STATUS') {
      throw this.unsupported(name, 'setFunction', 'Function is read-only or has no CI-V writer');
    }
    let value = enabled ? 1 : 0;
    if (name === 'SBKIN') value = enabled ? 1 : 0;
    if (name === 'FBKIN') value = enabled ? 2 : 0;
    this.writeFunctionRaw(spec, value);
  }

  async getLevel(name: IcomLevelName, options?: QueryOptions): Promise<number | null> {
    if (!this.activeProfile.levels.includes(name)) return null;
    const ext = this.activeProfile.extParamSpecs[name];
    if (ext) {
      return this.readExtParamValue(ext, `level-ext:${name}`, options);
    }
    const spec = LEVEL_SPECS[name];
    if (!spec) return null;
    const raw = await this.readLevelRaw(name, spec, options);
    if (raw === null) return null;
    return spec.rawToPublic ? spec.rawToPublic(raw) : spec.dataType === 'level' ? raw / 255 : raw;
  }

  setLevel(name: IcomLevelName, value: number): void {
    if (!this.activeProfile.levels.includes(name)) {
      throw this.unsupported(name, 'setLevel', 'Level is not enabled for active profile');
    }
    const ext = this.activeProfile.extParamSpecs[name];
    if (ext) {
      this.writeExtParamValue(ext, value);
      return;
    }
    const spec = LEVEL_SPECS[name];
    if (!spec) {
      throw this.unsupported(name, 'setLevel', 'No level command mapping');
    }
    const raw = spec.publicToRaw
      ? spec.publicToRaw(value)
      : spec.dataType === 'level'
        ? Math.round(Math.max(0, Math.min(1, value)) * 255)
        : Math.round(value);
    this.writeLevelRaw(spec, raw);
  }

  async getParameter(name: IcomParameterName, options?: QueryOptions): Promise<number | boolean | null> {
    if (!this.activeProfile.parameters.includes(name)) return null;
    const ext = this.activeProfile.extParamSpecs[name];
    if (!ext) return null;
    const value = await this.readExtParamValue(ext, `parm:${name}`, options);
    if (value === null) return null;
    return ext.dataType === 'bool' ? value !== 0 : value;
  }

  setParameter(name: IcomParameterName, value: number | boolean): void {
    if (!this.activeProfile.parameters.includes(name)) {
      throw this.unsupported(name, 'setParameter', 'Parameter is not enabled for active profile');
    }
    const ext = this.activeProfile.extParamSpecs[name];
    if (!ext) {
      throw this.unsupported(name, 'setParameter', 'No parameter command mapping');
    }
    this.writeExtParamValue(ext, typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }

  async getNoiseBlankerEnabled(options?: QueryOptions) { return this.getFunction('NB', options); }
  setNoiseBlankerEnabled(enabled: boolean) { this.setFunction('NB', enabled); }
  async getNoiseReductionEnabled(options?: QueryOptions) { return this.getFunction('NR', options); }
  setNoiseReductionEnabled(enabled: boolean) { this.setFunction('NR', enabled); }
  async getCompressorEnabled(options?: QueryOptions) { return this.getFunction('COMP', options); }
  setCompressorEnabled(enabled: boolean) { this.setFunction('COMP', enabled); }
  async getVoxEnabled(options?: QueryOptions) { return this.getFunction('VOX', options); }
  setVoxEnabled(enabled: boolean) { this.setFunction('VOX', enabled); }
  async getMonitorEnabled(options?: QueryOptions) { return this.getFunction('MON', options); }
  setMonitorEnabled(enabled: boolean) { this.setFunction('MON', enabled); }
  async getAutoNotchEnabled(options?: QueryOptions) { return this.getFunction('ANF', options); }
  setAutoNotchEnabled(enabled: boolean) { this.setFunction('ANF', enabled); }
  async getManualNotchEnabled(options?: QueryOptions) { return this.getFunction('MN', options); }
  setManualNotchEnabled(enabled: boolean) { this.setFunction('MN', enabled); }
  async getDialLockEnabled(options?: QueryOptions) { return this.getFunction('LOCK', options); }
  setDialLockEnabled(enabled: boolean) { this.setFunction('LOCK', enabled); }

  async getBreakInMode(options?: QueryOptions): Promise<'off' | 'semi' | 'full' | null> {
    const spec = FUNCTION_SPECS.SBKIN;
    if (!spec || !this.activeProfile.functions.includes('SBKIN')) return null;
    const raw = await this.readFunctionRaw('SBKIN', spec, options);
    if (raw === null) return null;
    return raw === 1 ? 'semi' : raw === 2 ? 'full' : 'off';
  }

  setBreakInMode(mode: 'off' | 'semi' | 'full'): void {
    const spec = FUNCTION_SPECS.SBKIN;
    if (!spec || !this.activeProfile.functions.includes('SBKIN')) {
      throw this.unsupported('SBKIN', 'setBreakInMode', 'Break-in function is not enabled for active profile');
    }
    this.writeFunctionRaw(spec, mode === 'semi' ? 1 : mode === 'full' ? 2 : 0);
  }

  async getRFGain(options?: QueryOptions) { return this.getLevel('RF', options); }
  setRFGain(value: number) { this.setLevel('RF', value); }
  async getIFShift(options?: QueryOptions) { return this.getLevel('IF', options); }
  setIFShift(value: number) { this.setLevel('IF', value); }
  async getPbtIn(options?: QueryOptions) { return this.getLevel('PBT_IN', options); }
  setPbtIn(value: number) { this.setLevel('PBT_IN', value); }
  async getPbtOut(options?: QueryOptions) { return this.getLevel('PBT_OUT', options); }
  setPbtOut(value: number) { this.setLevel('PBT_OUT', value); }
  async getCwPitch(options?: QueryOptions) { return this.getLevel('CWPITCH', options); }
  setCwPitch(hz: number) { this.setLevel('CWPITCH', hz); }
  async getKeySpeed(options?: QueryOptions) { return this.getLevel('KEYSPD', options); }
  setKeySpeed(wpm: number) { this.setLevel('KEYSPD', wpm); }

  async sendMorse(text: string, options: SendMorseOptions = {}): Promise<void> {
    const normalized = IcomControl.normalizeMorseText(text);
    if (normalized.length === 0) return;

    const generation = this.cwGeneration;
    return this.enqueueCw(async () => {
      if (generation !== this.cwGeneration) return;
      if (!this.activeProfile.cw.sendMorse) {
        throw this.unsupported('SEND_MORSE', 'sendMorse', 'CW text sending is not enabled for active profile');
      }

      const timeoutMs = options.timeout ?? 3000;
      if (options.checkMode !== false) {
        const mode = await this.readOperatingMode({ timeout: timeoutMs });
        if (!mode || (mode.mode !== MODE_MAP.CW && mode.mode !== MODE_MAP.CW_R)) {
          throw new Error(`CW 0x17 sendMorse requires CW/CW_R mode; current mode is ${mode?.modeName ?? mode?.mode ?? 'unknown'}`);
        }
      }

      const profileMax = Math.max(1, Math.min(30, this.activeProfile.cw.maxChunkLength || 30));
      const requested = Number.isFinite(options.chunkLength) ? Math.floor(options.chunkLength as number) : profileMax;
      const chunkLength = Math.max(1, Math.min(30, profileMax, requested));
      const interChunkDelayMs = Number.isFinite(options.interChunkDelayMs)
        ? Math.max(0, Math.floor(options.interChunkDelayMs as number))
        : 0;
      const bytes = Buffer.from(normalized, 'ascii');
      const ctrAddr = DEFAULT_CONTROLLER_ADDR;
      const rigAddr = this.civ.civAddress & 0xff;

      for (let offset = 0, chunkIndex = 1; offset < bytes.length; offset += chunkLength, chunkIndex++) {
        if (generation !== this.cwGeneration) return;
        const chunk = bytes.subarray(offset, Math.min(offset + chunkLength, bytes.length));
        const frame = IcomRigCommands.sendMorseText(ctrAddr, rigAddr, chunk);
        await this.sendCwFrameAndWaitForAck(frame, timeoutMs, `chunk ${chunkIndex}`);
        if (generation !== this.cwGeneration) return;
        if (interChunkDelayMs > 0 && offset + chunkLength < bytes.length) {
          await new Promise((resolve) => setTimeout(resolve, interChunkDelayMs));
        }
      }
    });
  }

  sendCwText(text: string, options?: SendMorseOptions): Promise<void> {
    return this.sendMorse(text, options);
  }

  async stopMorse(options: { timeout?: number } = {}): Promise<void> {
    this.cwGeneration += 1;
    return this.enqueueCw(async () => {
      if (!this.activeProfile.cw.sendMorse) {
        throw this.unsupported('SEND_MORSE', 'stopMorse', 'CW text sending is not enabled for active profile');
      }
      const ctrAddr = DEFAULT_CONTROLLER_ADDR;
      const rigAddr = this.civ.civAddress & 0xff;
      await this.sendCwFrameAndWaitForAck(IcomRigCommands.stopMorse(ctrAddr, rigAddr), options.timeout ?? 3000, 'stop');
    });
  }

  async getNotchRaw(options?: QueryOptions) { return this.getLevel('NOTCHF_RAW', options); }
  setNotchRaw(value: number) { this.setLevel('NOTCHF_RAW', value); }
  async getCompressionLevel(options?: QueryOptions) { return this.getLevel('COMP', options); }
  setCompressionLevel(value: number) { this.setLevel('COMP', value); }
  async getMonitorGain(options?: QueryOptions) { return this.getLevel('MONITOR_GAIN', options); }
  setMonitorGain(value: number) { this.setLevel('MONITOR_GAIN', value); }
  async getVoxGain(options?: QueryOptions) { return this.getLevel('VOXGAIN', options); }
  setVoxGain(value: number) { this.setLevel('VOXGAIN', value); }
  async getAntiVox(options?: QueryOptions) { return this.getLevel('ANTIVOX', options); }
  setAntiVox(value: number) { this.setLevel('ANTIVOX', value); }

  async getRitOffset(options?: QueryOptions) { return this.readRitOffset(options); }
  setRitOffset(offsetHz: number) { this.writeRitOffset(offsetHz); }
  async getXitOffset(options?: QueryOptions) { return this.readRitOffset(options); }
  setXitOffset(offsetHz: number) { this.writeRitOffset(offsetHz); }
  async getRitEnabled(options?: QueryOptions) { return this.getFunction('RIT', options); }
  setRitEnabled(enabled: boolean) { this.setFunction('RIT', enabled); }
  async getXitEnabled(options?: QueryOptions) { return this.getFunction('XIT', options); }
  setXitEnabled(enabled: boolean) { this.setFunction('XIT', enabled); }

  async getVfo(options?: QueryOptions): Promise<IcomVfoName | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, CIV.C_SET_VFO, CIV.S_BAND_SEL);
    const resp = await this.waitForCivFrame('vfo:0x07:0xd2', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_SET_VFO, [CIV.S_BAND_SEL], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 8) return null;
    return resp[6] === 0 ? 'MAIN' : 'SUB';
  }

  setVfo(vfo: IcomVfoName): void {
    const subcmd = this.vfoToSubcmd(vfo);
    if (subcmd === null) {
      throw this.unsupported(vfo, 'setVfo', 'VFO cannot be directly selected');
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_SET_VFO, subcmd));
  }

  vfoOperation(op: IcomVfoOperation): void {
    if (!this.activeProfile.vfoOps.includes(op)) {
      throw this.unsupported(op, 'vfoOperation', 'VFO operation is not enabled for active profile');
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    switch (op) {
      case 'copy':
        this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_SET_VFO, CIV.S_BTOA));
        return;
      case 'exchange':
        this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_SET_VFO, CIV.S_XCHNG));
        return;
      case 'from-vfo':
        this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_WR_MEM, undefined));
        return;
      case 'to-vfo':
        this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_MEM2VFO, undefined));
        return;
      case 'memory-clear':
        this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_CLR_MEM, undefined));
        return;
      case 'tune':
        this.sendCiv(IcomRigCommands.startManualTune(ctrAddr, rigAddr));
        return;
    }
  }

  async getSplitEnabled(options?: QueryOptions): Promise<boolean | null> {
    const raw = await this.readSplitRaw(options);
    if (raw === null) return null;
    return raw === CIV.S_SPLT_ON;
  }

  setSplitEnabled(enabled: boolean): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setSplit(ctrAddr, rigAddr, enabled));
  }

  async getSplitFrequency(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readSelectedFrequency(ctrAddr, rigAddr, 1);
    const resp = await this.waitForCivFrame('freq:0x25:1', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_SEND_SEL_FREQ, [0x01], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    return resp ? IcomControl.parseFrequencyReply(resp, 1) : null;
  }

  setSplitFrequency(hz: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setSelectedFrequency(ctrAddr, rigAddr, hz, this.activeProfile.frequencyBcdBytes(hz), 1));
  }

  async getSplitMode(options?: QueryOptions): Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string; dataMode?: boolean } | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readSelectedMode(ctrAddr, rigAddr, 1);
    const resp = await this.waitForCivFrame('mode:0x26:1', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_SEND_SEL_MODE, [0x01], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 10) return null;
    const { getModeString, getFilterString } = await import('./IcomConstants');
    const mode = resp[6];
    const dataMode = resp[7] !== 0x00;
    const filter = resp[8];
    return { mode, filter, dataMode, modeName: getModeString(mode), filterName: getFilterString(filter) };
  }

  setSplitMode(mode: IcomMode | number, options?: SetModeOptions): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const modeCode = typeof mode === 'string' ? getModeCode(mode) : mode;
    const filter = options?.filter ?? this.lastFilter ?? this.activeProfile.defaultFilter;
    this.sendCiv(IcomRigCommands.setSelectedMode(ctrAddr, rigAddr, modeCode, !!options?.dataMode, filter, 1));
  }

  async getTuningStep(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readTuningStep(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame('ts:0x10', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_SET_TS, [], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 7) return null;
    return this.activeProfile.tuningSteps.find((step) => step.code === resp[5])?.hz ?? null;
  }

  setTuningStep(hz: number): void {
    const matched = this.activeProfile.tuningSteps.find((step) => step.hz === hz);
    if (!matched) {
      throw this.unsupported(String(hz), 'setTuningStep', 'Tuning step is not enabled for active profile');
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setTuningStep(ctrAddr, rigAddr, matched.code));
  }

  async getRepeaterShift(options?: QueryOptions): Promise<IcomRepeaterShift | null> {
    const raw = await this.readSplitRaw(options);
    if (raw === null) return null;
    if (raw === CIV.S_DUP_M) return 'minus';
    if (raw === CIV.S_DUP_P) return 'plus';
    return 'none';
  }

  setRepeaterShift(shift: IcomRepeaterShift): void {
    if (!this.activeProfile.repeater) {
      throw this.unsupported(shift, 'setRepeaterShift', 'Repeater controls are not enabled for active profile');
    }
    const code = shift === 'minus' ? CIV.S_DUP_M : shift === 'plus' ? CIV.S_DUP_P : CIV.S_DUP_OFF;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setRepeaterShift(ctrAddr, rigAddr, code));
  }

  async getRepeaterOffset(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, CIV.C_RD_OFFS);
    const resp = await this.waitForCivFrame('rptr:offset', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_RD_OFFS, [], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 9) return null;
    return decodeFrequencyBcdLE(resp.subarray(5, 8)) * 100;
  }

  setRepeaterOffset(offsetHz: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_SET_OFFS, undefined, encodeFrequencyBcdLE(Math.round(offsetHz / 100), 3)));
  }

  async getToneFrequency(options?: QueryOptions) { return this.readTone(CIV.S_TONE_RPTR, options); }
  setToneFrequency(hz: number) { this.writeTone(CIV.S_TONE_RPTR, hz); }
  async getToneSquelchFrequency(options?: QueryOptions) { return this.readTone(CIV.S_TONE_SQL, options); }
  setToneSquelchFrequency(hz: number) { this.writeTone(CIV.S_TONE_SQL, hz); }

  async getBeepEnabled(options?: QueryOptions) { return this.getParameter('BEEP', options) as Promise<boolean | null>; }
  setBeepEnabled(enabled: boolean) { this.setParameter('BEEP', enabled); }
  async getBacklight(options?: QueryOptions) { return this.getParameter('BACKLIGHT', options) as Promise<number | null>; }
  setBacklight(value: number) { this.setParameter('BACKLIGHT', value); }
  async getScreenSaver(options?: QueryOptions) { return this.getParameter('SCREENSAVER', options) as Promise<number | null>; }
  setScreenSaver(value: number) { this.setParameter('SCREENSAVER', value); }
  async getKeyerType(options?: QueryOptions) { return this.getParameter('KEYERTYPE', options) as Promise<number | null>; }
  setKeyerType(value: number) { this.setParameter('KEYERTYPE', value); }

  async getAudioIfMode(options?: QueryOptions): Promise<IcomAudioIfSource | null> {
    for (const source of ['wlan', 'lan', 'acc'] as IcomAudioIfSource[]) {
      const parm = this.audioIfSourceToParameter(source);
      if (parm && this.activeProfile.parameters.includes(parm)) {
        const enabled = await this.getParameter(parm, options);
        if (enabled === true) return source;
      }
    }
    return this.activeProfile.audioIfSources.includes('default') ? 'default' : null;
  }

  setAudioIfMode(source: IcomAudioIfSource): void {
    if (!this.activeProfile.audioIfSources.includes(source)) {
      throw this.unsupported(source, 'setAudioIfMode', 'Audio IF source is not enabled for active profile');
    }
    for (const candidate of ['wlan', 'lan', 'acc'] as IcomAudioIfSource[]) {
      const parm = this.audioIfSourceToParameter(candidate);
      if (parm && this.activeProfile.parameters.includes(parm)) {
        this.setParameter(parm, source === candidate);
      }
    }
    if (this.activeProfile.parameters.includes('AFIF')) {
      this.setParameter('AFIF', source !== 'default');
    }
  }

  async getSpectrumDataOutput(options?: QueryOptions): Promise<boolean | null> {
    return this.getScopeBoolean(CIV.S_SCP_DOP, [], 'spectrum:data-output', options);
  }
  setSpectrumDataOutput(enabled: boolean): void { this.writeScopeSimple(CIV.S_SCP_DOP, [enabled ? 1 : 0]); }
  async getSpectrumHold(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<boolean | null> {
    const receiver = options?.receiver ?? 0;
    return this.getScopeBoolean(CIV.S_SCP_HLD, [receiver], `spectrum:hold:${receiver}`, options);
  }
  setSpectrumHold(enabled: boolean, options?: { receiver?: 0 | 1 }): void {
    const receiver = options?.receiver ?? 0;
    this.writeScopeSimple(CIV.S_SCP_HLD, [receiver, enabled ? 1 : 0]);
  }
  async getSpectrumSpeed(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<IcomSpectrumSpeed | null> {
    const receiver = options?.receiver ?? 0;
    const raw = await this.getScopeByte(CIV.S_SCP_SWP, [receiver], `spectrum:speed:${receiver}`, options);
    if (raw === null) return null;
    return raw === 0 ? 'fast' : raw === 1 ? 'mid' : 'slow';
  }
  setSpectrumSpeed(speed: IcomSpectrumSpeed, options?: { receiver?: 0 | 1 }): void {
    const receiver = options?.receiver ?? 0;
    const raw = speed === 'fast' ? 0 : speed === 'mid' ? 1 : 2;
    this.writeScopeSimple(CIV.S_SCP_SWP, [receiver, raw]);
  }
  async getSpectrumRef(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<number | null> {
    const receiver = options?.receiver ?? 0;
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, CIV.C_CTL_SCP, CIV.S_SCP_REF, [receiver]);
    const resp = await this.waitForCivFrame(`spectrum:ref:${receiver}`, (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_SCP, [CIV.S_SCP_REF, receiver], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 10) return null;
    const value = decodeBcdBE(resp.subarray(7, 9)) / 100;
    return resp[9] ? -value : value;
  }
  setSpectrumRef(db: number, options?: { receiver?: 0 | 1 }): void {
    const receiver = options?.receiver ?? 0;
    const rounded = Math.round(db * 2) / 2;
    this.writeScopeSimple(CIV.S_SCP_REF, [receiver, ...encodeBcdBE(Math.abs(Math.round(rounded * 100)), 2), rounded < 0 ? 1 : 0]);
  }
  async getSpectrumAverage(options?: QueryOptions): Promise<number | null> { return this.getLevel('SPECTRUM_AVG', options); }
  setSpectrumAverage(value: number): void { this.setLevel('SPECTRUM_AVG', value); }
  async getSpectrumVbw(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<number | null> {
    const receiver = options?.receiver ?? 0;
    return this.getScopeByte(CIV.S_SCP_VBW, [receiver], `spectrum:vbw:${receiver}`, options);
  }
  setSpectrumVbw(value: number, options?: { receiver?: 0 | 1 }): void {
    const receiver = options?.receiver ?? 0;
    this.writeScopeSimple(CIV.S_SCP_VBW, [receiver, Math.max(0, Math.min(1, Math.trunc(value)))]);
  }
  async getSpectrumRbw(options?: QueryOptions & { receiver?: 0 | 1 }): Promise<number | null> {
    const receiver = options?.receiver ?? 0;
    return this.getScopeByte(CIV.S_SCP_RBW, [receiver], `spectrum:rbw:${receiver}`, options);
  }
  setSpectrumRbw(value: number, options?: { receiver?: 0 | 1 }): void {
    const receiver = options?.receiver ?? 0;
    this.writeScopeSimple(CIV.S_SCP_RBW, [receiver, Math.max(0, Math.min(2, Math.trunc(value)))]);
  }
  async getSpectrumDuringTx(options?: QueryOptions): Promise<boolean | null> {
    return this.getScopeBoolean(CIV.S_SCP_STX, [], 'spectrum:during-tx', options);
  }
  setSpectrumDuringTx(enabled: boolean): void { this.writeScopeSimple(CIV.S_SCP_STX, [enabled ? 1 : 0]); }
  async getSpectrumCenterType(options?: QueryOptions): Promise<IcomSpectrumCenterType | null> {
    const raw = await this.getScopeByte(CIV.S_SCP_CFQ, [], 'spectrum:center-type', options);
    if (raw === null) return null;
    return raw === 1 ? 'carrier-point-center' : raw === 2 ? 'carrier-point-center-abs' : 'filter-center';
  }
  setSpectrumCenterType(type: IcomSpectrumCenterType): void {
    const raw = type === 'carrier-point-center' ? 1 : type === 'carrier-point-center-abs' ? 2 : 0;
    this.writeScopeSimple(CIV.S_SCP_CFQ, [raw]);
  }

  private unsupported(commandName: string, api: string, reason: string) {
    return new UnsupportedCommandError({
      modelId: this.getProfileModelId(),
      commandName: api,
      civCommand: commandName,
      reason,
    });
  }

  private enqueueCw<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.cwQueue.then(operation, operation);
    this.cwQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async sendCwFrameAndWaitForAck(frame: Buffer, timeoutMs: number, label: string): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const resp = await this.waitForCivFrame(
      'cw:ack:0x17',
      (candidate) => IcomControl.matchAckNakFrame(candidate, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(frame)
    );
    if (!resp) {
      throw new Error(`CW 0x17 ${label} ACK timeout`);
    }
    if (resp[4] === CIV.NAK) {
      throw new Error(`CW 0x17 ${label} NAK received`);
    }
  }

  private async readFunctionRaw(name: IcomFunctionName, spec: { command: number; subcmd: number; readPrefix?: number[] }, options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const prefix = spec.readPrefix ?? [];
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, spec.command, spec.subcmd, prefix);
    const tail = [spec.subcmd, ...prefix];
    const resp = await this.waitForCivFrame(`func:0x${spec.command.toString(16)}:0x${spec.subcmd.toString(16)}:${prefix.join('.')}:${name}`,
      (frame) => IcomControl.matchCommandFrame(frame, spec.command, tail, ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp) return null;
    const index = 5 + tail.length;
    return index < resp.length - 1 ? resp[index] : null;
  }

  private writeFunctionRaw(spec: { command: number; subcmd: number; payloadPrefix?: number[] }, value: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const payload = [...(spec.payloadPrefix ?? []), value & 0xff];
    this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, spec.command, spec.subcmd, payload));
  }

  private async readLevelRaw(name: IcomLevelName, spec: LevelSpec, options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, spec.command, spec.subcmd);
    const resp = await this.waitForCivFrame(`level:0x${spec.command.toString(16)}:0x${spec.subcmd.toString(16)}:${name}`,
      (frame) => IcomControl.matchCommandFrame(frame, spec.command, [spec.subcmd], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp) return null;
    const data = resp.subarray(6, resp.length - 1);
    if (data.length < spec.dataBytes) return null;
    return decodeBcdBE(data.subarray(0, spec.dataBytes));
  }

  private writeLevelRaw(spec: LevelSpec, raw: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, spec.command, spec.subcmd, IcomControl.encodeDataValue(raw, spec.dataType, spec.dataBytes)));
  }

  private async readExtParamValue(ext: IcomExtParam, keyPrefix: string, options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readExtParam(ctrAddr, rigAddr, ext.command, ext.subcmd, ext.subext);
    const tail = [ext.subcmd, ...ext.subext];
    const resp = await this.waitForCivFrame(`${keyPrefix}:0x${ext.command.toString(16)}:0x${ext.subcmd.toString(16)}:${ext.subext.join('.')}`,
      (frame) => IcomControl.matchCommandFrame(frame, ext.command, tail, ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp) return null;
    const start = 5 + tail.length;
    return IcomControl.decodeDataValue(resp.subarray(start, resp.length - 1), ext.dataType, ext.dataBytes);
  }

  private writeExtParamValue(ext: IcomExtParam, value: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const raw = ext.dataType === 'level' ? Math.round(Math.max(0, Math.min(1, value)) * 255) : Math.round(value);
    const payload = IcomControl.encodeDataValue(raw, ext.dataType, ext.dataBytes);
    this.sendCiv(IcomRigCommands.writeExtParam(ctrAddr, rigAddr, ext.command, ext.subcmd, ext.subext, payload));
  }

  private static encodeDataValue(value: number, dataType: IcomExtParam['dataType'], bytes: number): Buffer {
    if (dataType === 'time') {
      const seconds = Math.max(0, Math.round(value));
      const hhmm = Math.floor(seconds / 3600) * 100 + Math.floor(seconds / 60) % 60;
      return encodeBcdBE(hhmm, bytes);
    }
    return encodeBcdBE(value, bytes);
  }

  private static decodeDataValue(data: Buffer, dataType: IcomExtParam['dataType'], bytes: number): number | null {
    if (data.length < bytes) return null;
    const value = decodeBcdBE(data.subarray(0, bytes));
    if (dataType === 'level') return value / 255;
    if (dataType === 'bool') return value === 0 ? 0 : 1;
    if (dataType === 'time') {
      const hours = Math.floor(value / 100);
      const minutes = value % 100;
      return hours * 3600 + minutes * 60;
    }
    return value;
  }

  private async readRitOffset(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readRitOffset(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame('rit:offset', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_RIT, [CIV.S_RIT_FREQ], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 9) return null;
    const value = decodeFrequencyBcdLE(resp.subarray(6, 8));
    return resp[8] === 0 ? value : -value;
  }

  private writeRitOffset(offsetHz: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const payload = [...encodeFrequencyBcdLE(Math.abs(Math.round(offsetHz)), 2), offsetHz < 0 ? 1 : 0];
    this.sendCiv(IcomRigCommands.setRitOffset(ctrAddr, rigAddr, payload));
  }

  private vfoToSubcmd(vfo: IcomVfoName): number | null {
    switch (vfo) {
      case 'A': return CIV.S_VFOA;
      case 'B': return CIV.S_VFOB;
      case 'MAIN':
      case 'MAIN_A':
      case 'MAIN_B': return CIV.S_MAIN;
      case 'SUB':
      case 'SUB_A':
      case 'SUB_B': return CIV.S_SUB;
      case 'CURR':
      case 'TX': return null;
      case 'MEM': return null;
    }
  }

  private async readSplitRaw(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readSplit(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame('split:0x0f', (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_SPLT, [], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 7) return null;
    return resp[5];
  }

  private async readTone(subcmd: number, options?: QueryOptions): Promise<number | null> {
    if (!this.activeProfile.tone) return null;
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readTone(ctrAddr, rigAddr, subcmd);
    const resp = await this.waitForCivFrame(`tone:0x${subcmd.toString(16)}`, (frame) => IcomControl.matchCommandFrame(frame, CIV.C_SET_TONE, [subcmd], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp || resp.length < 10) return null;
    return decodeBcdBE(resp.subarray(6, 9)) / 10;
  }

  private writeTone(subcmd: number, hz: number): void {
    if (!this.activeProfile.tone) {
      throw this.unsupported(String(subcmd), 'setToneFrequency', 'Tone controls are not enabled for active profile');
    }
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setTone(ctrAddr, rigAddr, subcmd, Math.round(hz * 10)));
  }

  private audioIfSourceToParameter(source: IcomAudioIfSource): IcomParameterName | null {
    switch (source) {
      case 'wlan': return 'AFIF_WLAN';
      case 'lan': return 'AFIF_LAN';
      case 'acc': return 'AFIF_ACC';
      case 'default': return 'AFIF';
    }
  }

  private async getScopeBoolean(subcmd: number, payload: number[], key: string, options?: QueryOptions): Promise<boolean | null> {
    const raw = await this.getScopeByte(subcmd, payload, key, options);
    return raw === null ? null : raw !== 0;
  }

  private async getScopeByte(subcmd: number, payload: number[], key: string, options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readCommand(ctrAddr, rigAddr, CIV.C_CTL_SCP, subcmd, payload);
    const resp = await this.waitForCivFrame(key, (frame) => IcomControl.matchCommandFrame(frame, CIV.C_CTL_SCP, [subcmd, ...payload], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp) return null;
    const index = 5 + 1 + payload.length;
    return index < resp.length - 1 ? resp[index] : null;
  }

  private writeScopeSimple(subcmd: number, payload: number[]): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.writeCommand(ctrAddr, rigAddr, CIV.C_CTL_SCP, subcmd, payload));
  }

  private static isReplyOf(frame: Buffer, cmd: number, ctrAddr: number, rigAddr: number) {
    // typical reply FE FE [ctr] [rig] cmd ... FD
    return frame.length >= 7 && frame[0] === 0xfe && frame[1] === 0xfe && frame[4] === (cmd & 0xff);
  }

  /**
   * Extract meter data from CI-V response frame
   * CI-V format: FE FE [ctr] [rig] [cmd] [subcmd] [data0] [data1] FD
   * @param frame - CI-V response buffer
   * @returns Parsed BCD integer value, or null if invalid
   */
  private static extractMeterData(frame: Buffer | null): number | null {
    if (!frame || frame.length < 9) return null;
    // FE FE [ctr] [rig] 0x15 [sub] [bcd_hi] [bcd_lo] FD
    return decodeBcdBE(frame.subarray(6, 8));
  }

  private static extractTrailingBcd(frame: Buffer | null, byteLength: number): number | null {
    if (!frame || frame.length < 6 + byteLength) return null;
    const end = frame.length - 1;
    const start = end - byteLength;
    if (start < 5) return null;
    return decodeBcdBE(frame.subarray(start, end));
  }

  private static matchCommand(frame: Buffer, cmd: number, tail: number[]) {
    // FE FE ?? ?? cmd ... tail... FD
    if (!(frame.length >= 7 && frame[0] === 0xfe && frame[1] === 0xfe && frame[4] === (cmd & 0xff))) return false;
    if (tail.length === 0) return true;
    for (let i = 0; i + tail.length < frame.length; i++) {
      let ok = true;
      for (let j = 0; j < tail.length; j++) {
        if (frame[i + j] !== tail[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  // Strict command matcher on full CI-V frame (optional address check)
  private static matchCommandFrame(frame: Buffer, cmd: number, tail: number[], ctrAddr?: number, rigAddr?: number) {
    if (!(frame.length >= 7 && frame[0] === 0xfe && frame[1] === 0xfe)) return false;
    if (ctrAddr !== undefined) {
      const addrCtrOk = frame[2] === (ctrAddr & 0xff) || frame[2] === 0x00;
      if (!addrCtrOk) return false;
    }
    if (rigAddr !== undefined) {
      if (frame[3] !== (rigAddr & 0xff)) return false;
    }
    if (frame[4] !== (cmd & 0xff)) return false;
    // tail should match starting at byte 5
    if (5 + tail.length > frame.length) return false;
    for (let i = 0; i < tail.length; i++) {
      if (frame[5 + i] !== tail[i]) return false;
    }
    if (frame[frame.length - 1] !== 0xfd) return false;
    return true;
  }

  private static matchAckNakFrame(frame: Buffer, ctrAddr: number, rigAddr: number) {
    if (!(frame.length >= 6 && frame[0] === CIV.PR && frame[1] === CIV.PR)) return false;
    const addrCtrOk = frame[2] === (ctrAddr & 0xff) || frame[2] === 0x00;
    if (!addrCtrOk || frame[3] !== (rigAddr & 0xff)) return false;
    if (frame[4] !== CIV.ACK && frame[4] !== CIV.NAK) return false;
    return frame[frame.length - 1] === CIV.FI;
  }

  private static normalizeMorseText(text: string): string {
    if (typeof text !== 'string') {
      throw new Error('CW 0x17 sendMorse text must be a string');
    }
    const normalized = text.toUpperCase().replace(/[\r\n\t]/g, ' ');
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) {
        throw new Error(`CW 0x17 sendMorse text contains unsupported non-printable or non-ASCII character at index ${i}`);
      }
    }
    return normalized;
  }

  private async waitForCiv(predicate: (frame: Buffer) => boolean, timeoutMs: number, onSend?: () => void): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      let done = false;
      const onFrame = (data: { pcm16?: Buffer } | Buffer) => {
        // our event emits Buffer of CI-V payload
        const frame = data as Buffer;
        if (!done && predicate(frame)) {
          done = true;
          this.ev.off('civ', onFrame as any);
          resolve(frame);
        }
      };
      this.ev.on('civ', onFrame as any);
      if (onSend) onSend();
      setTimeout(() => {
        if (!done) {
          this.ev.off('civ', onFrame as any);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  static parseFrequencyReply(frame: Buffer, payloadOffsetAfterCommand: number, byteLength?: number): number | null {
    if (!(frame && frame.length >= 7)) return null;
    if (frame[0] !== 0xfe || frame[1] !== 0xfe || frame[frame.length - 1] !== 0xfd) return null;
    const start = 5 + payloadOffsetAfterCommand;
    const maxBytes = frame.length - 1 - start;
    const len = byteLength ?? (maxBytes >= 6 ? 6 : 5);
    if (maxBytes < len || len <= 0) return null;
    return decodeFrequencyBcdLE(frame.subarray(start, start + len));
  }

  // Parse standard CI-V 0x03 read-frequency replies.
  static parseIcomFreqFromReply(frame: Buffer): number | null {
    if (!IcomControl.matchCommandFrame(frame, CIV.C_RD_FREQ, [])) return null;
    return IcomControl.parseFrequencyReply(frame, 0);
  }

  sendAudioFloat32(samples: Float32Array, addLeadingBuffer: boolean = false) {
    this.audio.enqueueFloat32(samples, addLeadingBuffer);
  }
  sendAudioPcm16(samples: Int16Array) { this.audio.enqueuePcm16(samples); }

  private onData(buf: Buffer) {
    // common demux by length
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    // dbg/dbgV imported at top
    switch (buf.length) {
      case Sizes.CONTROL: {
        const type = ControlPacket.getType(buf);
        dbg('CTRL <= type=0x' + type.toString(16));
        if (type === Cmd.I_AM_HERE) {
          this.sess.remoteId = ControlPacket.getSentId(buf);
          dbg('I_AM_HERE remoteId=', this.sess.remoteId);
          this.sess.stopAreYouThere();
          this.sess.startPing();
          // ask ready
          this.sess.sendUntracked(ControlPacket.toBytes(Cmd.ARE_YOU_READY, 1, this.sess.localId, this.sess.remoteId));
        } else if (type === Cmd.I_AM_READY) {
          dbg('I_AM_READY -> send login');
          // send login
          const login = LoginPacket.build(0, this.sess.localId, this.sess.remoteId, this.sess.innerSeq,
            this.sess.localToken, this.sess.rigToken, this.options.userName, this.options.password, 'FT8CN-Node');
          this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
          this.sess.sendTracked(login);
          this.sess.startIdle();
        }
        break;
      }
      case Sizes.TOKEN: {
        // token renewal / confirm responses
        const reqType = TokenPacket.getRequestType(buf);
        const reqReply = TokenPacket.getRequestReply(buf);
        dbg('TOKEN <= type=', reqType, 'reply=', reqReply);
        if (reqType === TokenType.RENEWAL && reqReply === 0x02 && ControlPacket.getType(buf) !== Cmd.RETRANSMIT) {
          const response = TokenPacket.getResponse(buf);
        dbgV('TOKEN renewal response=', response);
          if (response === 0x00000000) {
            // ok
          } else if (response === 0xffffffff) {
            // rejected; attempt re-connect
            this.sess.remoteId = ControlPacket.getSentId(buf);
            this.sess.localToken = TokenPacket.getTokRequest(buf);
            this.sess.rigToken = TokenPacket.getToken(buf);
            this.sendConnectionRequest();
          }
        }
        break;
      }
      case Sizes.STATUS: {
        const civPort = StatusPacket.getRigCivPort(buf);
        const audioPort = StatusPacket.getRigAudioPort(buf);
        const connected = StatusPacket.getIsConnected(buf);
        const authOK = StatusPacket.authOK(buf);
        dbg('STATUS <= civPort=', civPort, 'audioPort=', audioPort, 'authOK=', authOK, 'connected=', connected);

        // If radio reports disconnected, handle immediately
        if (!connected) {
          dbg('Radio reported connected=false');

          // If we're currently attempting to connect, abort immediately (fast-fail)
          const currentPhase = this.connectionSession.phase;
          if (currentPhase === ConnectionPhase.CONNECTING || currentPhase === ConnectionPhase.RECONNECTING) {
            dbg('Aborting ongoing connection attempt due to connected=false');
            this.abortConnectionAttempt(this.connectionSession.sessionId, DisconnectReason.ERROR, false);
          } else if (currentPhase === ConnectionPhase.CONNECTED) {
            // Trigger reconnection for established connection
            dbg('Triggering reconnection for established connection');
            this.handleConnectionLost(SessionType.CONTROL, 0);
          }
          break;
        }

        // CRITICAL: Ignore STATUS packets with invalid ports (0)
        // Radio sends multiple STATUS packets during connection:
        //   1. First with valid ports (e.g., 50002, 50003) when CONNINFO busy=false
        //   2. Second with port=0 when CONNINFO busy=true (should be ignored!)
        // If we don't check, the second packet will overwrite the valid ports with 0
        if (civPort === 0 || audioPort === 0) {
          dbg('STATUS packet has invalid ports (0) - ignoring to preserve existing valid ports');
          dbg('This is normal during reconnection when rig sends CONNINFO busy=true');
          // Still emit status event for monitoring, but don't setRemote
          const info: StatusInfo = { civPort, audioPort, authOK, connected };
          this.ev.emit('status', info);
          break;
        }

        const info: StatusInfo = { civPort, audioPort, authOK: true, connected: true };
        this.ev.emit('status', info);

        // Only set remote ports and start sessions if ports are valid (non-zero)
        dbg('STATUS has valid ports - setting up CIV/Audio sessions');
        if (this.civSess) { this.civSess.setRemote(this.options.control.ip, civPort); this.civSess.startAreYouThere(); this.civ.start(); }
        if (this.audioSess) { this.audioSess.setRemote(this.options.control.ip, audioPort); this.audioSess.startAreYouThere(); }
        break;
      }
      case Sizes.LOGIN_RESPONSE: {
        const ok = LoginResponsePacket.authOK(buf);
        dbg('LOGIN_RESPONSE ok=', ok, 'conn=', LoginResponsePacket.getConnection(buf));
        if (ok) {
          this.sess.rigToken = LoginResponsePacket.getToken(buf);
          // send token confirm
          const tok = TokenPacket.build(0, this.sess.localId, this.sess.remoteId, TokenType.CONFIRM, this.sess.innerSeq, this.sess.localToken, this.sess.rigToken);
          this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
          this.sess.sendTracked(tok);
          // start token renewal timer (60s)
          if (!this.tokenTimer) {
            this.tokenTimer = setInterval(() => {
              dbg('TOKEN -> renewal');
              const renew = TokenPacket.build(0, this.sess.localId, this.sess.remoteId, TokenType.RENEWAL, this.sess.innerSeq, this.sess.localToken, this.sess.rigToken);
              this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
              this.sess.sendTracked(renew);
            }, 60000);
          }
        }
        const res: LoginResult = { ok, errorCode: LoginResponsePacket.errorNum(buf), connection: LoginResponsePacket.getConnection(buf) };
        this.ev.emit('login', res);
        // Note: login event is caught by createReadyPromises() listener
        break;
      }
      case Sizes.CAP_CAP: {
        const cap = CapCapabilitiesPacket.getRadioCapPacket(buf, 0);
        if (cap) {
          const info: CapabilitiesInfo = {
            civAddress: RadioCapPacket.getCivAddress(cap),
            audioName: RadioCapPacket.getAudioName(cap),
            supportTX: RadioCapPacket.getSupportTX(cap)
          };
          if (info.civAddress != null) {
            this.civ.civAddress = info.civAddress;
            this.resolveActiveProfile({ civAddress: info.civAddress });
            info.modelId = this.activeProfile.modelId;
            info.profileName = this.activeProfile.profileName;
          }
          if (info.supportTX != null) this.civ.supportTX = info.supportTX;
          dbgV('CAP <= civAddr=', info.civAddress, 'audioName=', info.audioName, 'supportTX=', info.supportTX, 'profile=', info.modelId);
          this.ev.emit('capabilities', info);
        }
        break;
      }
      case Sizes.CONNINFO: {
        // rig sends twice; first time busy=false, reply with our ports
        // IMPORTANT: During reconnection, rig may send busy=true if old connection not fully cleaned up
        // We MUST still reply to proceed with connection (otherwise STATUS packet will never arrive)
        const busy = ConnInfoPacket.getBusy(buf);
        this.macAddress = ConnInfoPacket.getMacAddress(buf);
        this.rigName = ConnInfoPacket.getRigName(buf);
        this.resolveActiveProfile({ rigName: this.rigName });
        dbg('CONNINFO <= busy=', busy, 'rigName=', this.rigName, 'profile=', this.activeProfile.modelId);

        if (busy) {
          dbg('CONNINFO busy=true detected - likely reconnecting while rig still has old session');
          dbg('Sending ConnInfo reply anyway to allow STATUS packet delivery');
        }

        // ALWAYS send reply (even when busy=true during reconnection)
        const reply = ConnInfoPacket.connInfoPacketData(
          buf, 0, this.sess.localId, this.sess.remoteId, 0x01, 0x03, this.sess.innerSeq, this.sess.localToken, this.sess.rigToken,
          this.rigName, this.options.userName, AUDIO_SAMPLE_RATE, AUDIO_SAMPLE_RATE, this.civSess.localPort, this.audioSess.localPort, XIEGU_TX_BUFFER_SIZE
        );
        this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
        this.sess.sendTracked(reply);
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { hex } = require('../utils/codec');
          dbg('CONNINFO -> reply with local civPort=', this.civSess.localPort, 'audioPort=', this.audioSess.localPort);
          dbgV('CONNINFO reply hex (first 0x60):', hex(Buffer.from(reply.subarray(0, 0x60))));
          dbgV('CONNINFO reply hex (0x60..0x90):', hex(Buffer.from(reply.subarray(0x60, 0x90))));
        } catch {}
        break;
      }
      default: {
        // CIV and Audio are variable length; route by headers
        if (CivPacket.isCiv(buf)) {
          // CIV
          const payload = CivPacket.getCivData(buf);
          dbg('CIV <=', payload.length, 'bytes');
          this.ev.emit('civ', payload);
        } else if (
          buf.length >= 0x18 &&
          (buf[0x10] === 0x97 || buf[0x10] === 0x00) &&
          ((buf[0x11] === 0x81) || (buf[0x11] === 0x80))
        ) {
          const len = buf.readUInt16BE(0x16);
          const audio = Buffer.from(buf.subarray(0x18, 0x18 + len));
          dbg('AUDIO <=', audio.length, 'bytes');
          this.ev.emit('audio', { pcm16: audio });
        } else if (buf.length === Sizes.CONTROL && ControlPacket.getType(buf) === Cmd.RETRANSMIT) {
          dbgV('RETRANSMIT <= single', ControlPacket.getSeq(buf));
          // single retransmit
          this.sess.retransmit(ControlPacket.getSeq(buf));
        } else if (ControlPacket.getType(buf) === Cmd.RETRANSMIT && buf.length > Sizes.CONTROL) {
          dbgV('RETRANSMIT <= multi count=', Math.floor((buf.length - 0x10)/2));
          for (let i = 0x10; i + 1 < buf.length; i += 2) {
            const seq = buf.readUInt16LE(i);
            this.sess.retransmit(seq);
          }
        } else if (buf.length === Sizes.PING && Cmd.PING === ControlPacket.getType(buf)) {
          // ping handling
          if (buf[0x10] === 0x00) {
            // reply to radio ping
            const rep = PingPacket.buildReply(buf, this.sess.localId, this.sess.remoteId);
            dbgV('PING <= request -> reply');
            this.sess.sendUntracked(rep);
          } else {
            // reply to our ping; seq ok -> bump
            if (ControlPacket.getSeq(buf) === this.sess.pingSeq) this.sess.pingSeq = (this.sess.pingSeq + 1) & 0xffff;
            dbgV('PING <= reply seq=', ControlPacket.getSeq(buf));
          }
        }
      }
    }
  }

  private onCivData(buf: Buffer) {
    // mirror some generic handling on sub-session
    if (buf.length === Sizes.CONTROL) {
      const type = ControlPacket.getType(buf);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      dbg('CIV CTRL <= type=0x' + type.toString(16));
      if (type === Cmd.I_AM_HERE) {
        this.civSess.remoteId = ControlPacket.getSentId(buf);
        this.civSess.stopAreYouThere();
        this.civSess.startPing();
        // send ARE_YOU_READY with seq=1
        this.civSess.sendUntracked(ControlPacket.toBytes(Cmd.ARE_YOU_READY, 1, this.civSess.localId, this.civSess.remoteId));
        return;
      }
      if (type === Cmd.I_AM_READY) {
        this.civ.sendOpenClose(true);
        this.civSess.startIdle();
        dbg('CIV ready - emitting internal _civReady event');
        this.ev.emit('_civReady' as any);
        return;
      }
    }
    // CIV data frames
    // Diagnostic: check for potential CIV packets
    if (buf.length > 0x15 && buf[0x10] === 0xc1) {
      dbg(`CIV? len=${buf.length} [0x10]=0xc1 validating...`);
      if (CivPacket.isCiv(buf)) {
        const payload = CivPacket.getCivData(buf);
        dbg('CIV <=', payload.length, 'bytes');
        // Emit raw CIV payload for backward compatibility
        this.ev.emit('civ', payload);
        // Reassemble CIV frames (FE FE ... FD) and emit per-frame events
        this.processCivPayload(payload);
        return;
      } else {
        dbg(`CIV validation FAILED len=${buf.length}`);
      }
    }
    if (buf.length === Sizes.PING && Cmd.PING === ControlPacket.getType(buf)) {
      if (buf[0x10] === 0x00) {
        const rep = PingPacket.buildReply(buf, this.civSess!.localId, this.civSess!.remoteId);
        this.civSess!.sendUntracked(rep);
      } else if (ControlPacket.getSeq(buf) === (this.civSess!.pingSeq)) {
        this.civSess!.pingSeq = (this.civSess!.pingSeq + 1) & 0xffff;
      }
    }
    if (buf.length === Sizes.CONTROL && ControlPacket.getType(buf) === Cmd.RETRANSMIT) {
      this.civSess?.retransmit(ControlPacket.getSeq(buf));
    } else if (ControlPacket.getType(buf) === Cmd.RETRANSMIT && buf.length > Sizes.CONTROL) {
      for (let i = 0x10; i + 1 < buf.length; i += 2) this.civSess?.retransmit(buf.readUInt16LE(i));
    }
  }

  // Append CIV payload bytes and emit complete CI-V frames (FE FE ... FD)
  private processCivPayload(payload: Buffer) {
    // Append new data
    this.civAssembleBuf = Buffer.concat([this.civAssembleBuf, payload]);

    // Try to extract frames in a loop
    while (true) {
      // Find start marker FE FE
      let start = -1;
      for (let i = 0; i + 1 < this.civAssembleBuf.length; i++) {
        if (this.civAssembleBuf[i] === 0xfe && this.civAssembleBuf[i + 1] === 0xfe) { start = i; break; }
      }
      if (start < 0) {
        // No start marker: drop noise before potential next packet
        if (this.civAssembleBuf.length > 1024) this.civAssembleBuf = Buffer.alloc(0);
        return;
      }

      // Trim leading noise
      if (start > 0) this.civAssembleBuf = this.civAssembleBuf.subarray(start);

      // Find end marker FD after start
      let end = -1;
      for (let i = 2; i < this.civAssembleBuf.length; i++) {
        if (this.civAssembleBuf[i] === 0xfd) { end = i; break; }
      }
      if (end < 0) {
        // Incomplete frame, wait for more data
        return;
      }

      // Extract frame [0..end]
      const frame = Buffer.from(this.civAssembleBuf.subarray(0, end + 1));
      // Advance buffer
      this.civAssembleBuf = this.civAssembleBuf.subarray(end + 1);
      // Emit event
      this.ev.emit('civFrame', frame);
      this.scope.handleCivFrame(frame, 'lan-civ');
      // Continue loop in case multiple frames are in buffer
    }
  }

  // Wait for a CI-V reply by response key. Same-key queries are deduplicated.
  private async waitForCivFrame(key: string, predicate: (frame: Buffer) => boolean, timeoutMs: number, onSend?: () => void): Promise<Buffer | null> {
    return this.civRequestManager.query({
      key,
      predicate,
      timeoutMs,
      send: () => { if (onSend) onSend(); },
    });
  }

  // Strict meter reply matcher: FE FE [ctr|00] [rig] 0x15 [sub] ... FD
  private static isMeterReply(frame: Buffer, subcmd: number, ctrAddr: number, rigAddr: number) {
    if (!(frame && frame.length >= 9)) return false;
    if (frame[0] !== 0xfe || frame[1] !== 0xfe) return false;
    const addrCtrOk = frame[2] === (ctrAddr & 0xff) || frame[2] === 0x00;
    const addrRigOk = frame[3] === (rigAddr & 0xff);
    if (!addrCtrOk || !addrRigOk) return false;
    if (frame[4] !== 0x15) return false;
    if (frame[5] !== (subcmd & 0xff)) return false;
    if (frame[frame.length - 1] !== 0xfd) return false;
    return true;
  }

  // Strict 0x14 data reply matcher: FE FE [ctr|00] [rig] 0x14 [sub] [bcd_hi] [bcd_lo] FD
  private static is0x14DataReply(frame: Buffer, subcmd: number, ctrAddr: number, rigAddr: number) {
    if (!(frame && frame.length >= 9)) return false;
    if (frame[0] !== 0xfe || frame[1] !== 0xfe) return false;
    const addrCtrOk = frame[2] === (ctrAddr & 0xff) || frame[2] === 0x00;
    const addrRigOk = frame[3] === (rigAddr & 0xff);
    if (!addrCtrOk || !addrRigOk) return false;
    if (frame[4] !== 0x14) return false;
    if (frame[5] !== (subcmd & 0xff)) return false;
    if (frame[frame.length - 1] !== 0xfd) return false;
    return true;
  }

  /**
   * Read a 0x14 level value from the radio.
   * Returns normalized value 0.0-1.0, or null on timeout/error.
   */
  private async read0x14Level(subcmd: number, options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.get0x14Level(ctrAddr, rigAddr, subcmd);
    const resp = await this.waitForCivFrame(
      `level:0x14:0x${subcmd.toString(16)}`,
      (frame) => IcomControl.is0x14DataReply(frame, subcmd, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp || resp.length < 9) return null;
    const raw = parseTwoByteBcd(resp.subarray(6, 8));
    return raw / 255;
  }

  /**
   * Write a 0x14 level value to the radio.
   * @param value - Normalized value 0.0-1.0
   */
  private write0x14Level(subcmd: number, value: number): void {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const raw = Math.max(0, Math.min(255, Math.round(value * 255)));
    const bcd = intToTwoByteBcd(raw);
    this.sendCiv(IcomRigCommands.set0x14Level(ctrAddr, rigAddr, subcmd, bcd[0], bcd[1]));
  }

  // Start meter polling like Java (every 500ms when PTT is on)
  private startMeterPolling() {
    this.stopMeterPolling();
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.meterTimer = setInterval(() => {
      if (!this.audio.isPttOn) return; // safety
      this.sendCiv(IcomRigCommands.getSWRState(ctrAddr, rigAddr));
      this.sendCiv(IcomRigCommands.getALCState(ctrAddr, rigAddr));
    }, METER_TIMER_PERIOD_MS);
  }

  private stopMeterPolling() {
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = undefined; }
  }

  private onAudioData(buf: Buffer) {
    if (buf.length === Sizes.CONTROL) {
      const type = ControlPacket.getType(buf);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      dbg('AUDIO CTRL <= type=0x' + type.toString(16));
      if (type === Cmd.I_AM_HERE) {
        this.audioSess.remoteId = ControlPacket.getSentId(buf);
        this.audioSess.stopAreYouThere();
        this.audioSess.startPing();
        this.audioSess.sendUntracked(ControlPacket.toBytes(Cmd.ARE_YOU_READY, 1, this.audioSess.localId, this.audioSess.remoteId));
        return;
      }
      if (type === Cmd.I_AM_READY) {
        // Start continuous audio transmission (like Java's startTxAudio on I_AM_READY)
        this.audio.start();
        this.audioSess.startIdle();
        dbg('Audio ready - started continuous audio stream, emitting internal _audioReady event');
        this.ev.emit('_audioReady' as any);
        return;
      }
    }
    // AUDIO frames (len >= 0x18 and datalen matches). We don't strictly validate ident here to support variants.
    if (buf.length >= 0x18) {
      // datalen is BE (Java uses shortToByte which is big-endian)
      const dataLen = buf.readUInt16BE(0x16);
      if (buf.length === 0x18 + dataLen && dataLen > 0 && dataLen <= 2048) {
        const audio = Buffer.from(buf.subarray(0x18, 0x18 + dataLen));
        // Surface the wire-level sequence number (0x12 BE) and RX arrival time so
        // consumers can detect packet loss/reordering at the application layer.
        this.ev.emit('audio', { pcm16: audio, seq: AudioPacket.getAudioSeq(buf), timestampMs: Date.now() });
        return;
      }
    }
    if (buf.length === Sizes.PING && Cmd.PING === ControlPacket.getType(buf)) {
      if (buf[0x10] === 0x00) {
        const rep = PingPacket.buildReply(buf, this.audioSess!.localId, this.audioSess!.remoteId);
        this.audioSess!.sendUntracked(rep);
      } else if (ControlPacket.getSeq(buf) === (this.audioSess!.pingSeq)) {
        this.audioSess!.pingSeq = (this.audioSess!.pingSeq + 1) & 0xffff;
      }
    }
    if (buf.length === Sizes.CONTROL && ControlPacket.getType(buf) === Cmd.RETRANSMIT) {
      this.audioSess?.retransmit(ControlPacket.getSeq(buf));
    } else if (ControlPacket.getType(buf) === Cmd.RETRANSMIT && buf.length > Sizes.CONTROL) {
      for (let i = 0x10; i + 1 < buf.length; i += 2) this.audioSess?.retransmit(buf.readUInt16LE(i));
    }
    // audio data routed by main handler already (if using single session). Here we may add specific behaviors if needed.
  }

  private sendConnectionRequest() {
    if (!this.civSess || !this.audioSess) return;
    const pkt = ConnInfoPacket.connectRequestPacket(0, this.sess.localId, this.sess.remoteId, 0x01, 0x03,
      this.sess.innerSeq, this.sess.localToken, this.sess.rigToken, this.macAddress, this.rigName, this.options.userName,
      AUDIO_SAMPLE_RATE, this.civSess.localPort, this.audioSess.localPort, XIEGU_TX_BUFFER_SIZE);
    this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
    this.sess.sendTracked(pkt);
  }

  // ============================================================================
  // Connection Monitoring
  // ============================================================================

  /**
   * Configure unified connection monitoring
   * @param config - Monitoring configuration options
   * @example
   * rig.configureMonitoring({ timeout: 10000, checkInterval: 2000, autoReconnect: true });
   */
  configureMonitoring(config: ConnectionMonitorConfig) {
    this.monitorConfig = { ...this.monitorConfig, ...config };
  }

  /**
   * Get current connection state for all sessions
   * @returns Object with connection state for each session
   */
  getConnectionState(): { control: ConnectionState; civ: ConnectionState; audio: ConnectionState } {
    const now = Date.now();
    const isTimedOut = (sess: Session) => {
      if (sess['destroyed']) return true;
      return (now - sess.lastReceivedTime) > this.monitorConfig.timeout;
    };

    return {
      control: isTimedOut(this.sess) ? ConnectionState.DISCONNECTED : ConnectionState.CONNECTED,
      civ: isTimedOut(this.civSess) ? ConnectionState.DISCONNECTED : ConnectionState.CONNECTED,
      audio: isTimedOut(this.audioSess) ? ConnectionState.DISCONNECTED : ConnectionState.CONNECTED
    };
  }

  /**
   * Check if any session has lost connection
   * @returns true if any session is disconnected
   */
  isAnySessionDisconnected(): boolean {
    const state = this.getConnectionState();
    return state.control === ConnectionState.DISCONNECTED ||
           state.civ === ConnectionState.DISCONNECTED ||
           state.audio === ConnectionState.DISCONNECTED;
  }

  /**
   * Handle connection lost event from a session
   * Simplified strategy: any session loss triggers full reconnect
   * @private
   */
  private handleConnectionLost(sessionType: SessionType, timeSinceLastData: number) {
    // Record disconnect time for downtime calculation
    this.connectionSession.lastDisconnectTime = Date.now();

    const info: ConnectionLostInfo = {
      sessionType,
      reason: `No data received for ${timeSinceLastData}ms`,
      timeSinceLastData,
      timestamp: this.connectionSession.lastDisconnectTime
    };
    dbg(`Connection lost: ${sessionType} session (${timeSinceLastData}ms since last data)`);
    this.ev.emit('connectionLost', info);

    // Check if auto-reconnect is enabled
    if (!this.monitorConfig.autoReconnect) {
      dbg(`Auto-reconnect disabled, not attempting reconnect`);
      // Transition to IDLE since we won't reconnect
      this.transitionTo(ConnectionPhase.IDLE, 'Connection lost, auto-reconnect disabled');
      return;
    }

    // Validate state transition to RECONNECTING
    if (!this.canTransitionTo(ConnectionPhase.RECONNECTING)) {
      dbg(`Cannot transition to RECONNECTING from ${this.connectionSession.phase} - skipping reconnect`);
      return;
    }

    // Simplified strategy: any session loss → full reconnect
    // This is more reliable than trying to reconnect individual sessions
    dbg(`${sessionType} session lost - initiating full reconnect`);
    this.scheduleFullReconnect();
  }

  /**
   * Schedule a full reconnection (all sessions)
   * Uses simple while loop with exponential backoff
   * @private
   */
  private async scheduleFullReconnect() {
    // Prevent multiple concurrent reconnect attempts
    if (this.connectionSession.phase === ConnectionPhase.RECONNECTING) {
      dbg('Full reconnect already in progress, skipping');
      return;
    }

    // Transition to RECONNECTING state
    this.transitionTo(ConnectionPhase.RECONNECTING, 'Starting full reconnect');

    let attempt = 0;
    const disconnectTime = this.connectionSession.lastDisconnectTime || Date.now();

    try {
      while (true) {
        attempt++;
        const delay = this.calculateReconnectDelay(attempt);

        // Emit reconnect attempting event
        this.ev.emit('reconnectAttempting', {
          sessionType: SessionType.CONTROL,
          attemptNumber: attempt,
          delay,
          timestamp: Date.now(),
          fullReconnect: true
        });

        dbg(`Full reconnect attempt #${attempt} (delay: ${delay}ms)`);
        await this.sleep(delay);

        try {
          // Disconnect all sessions - wrap in try-catch to prevent disconnect errors from aborting reconnect
          dbg('Full reconnect: disconnecting all sessions');
          try {
            await this.disconnect();
          } catch (disconnectErr) {
            // Log but don't fail - we still want to attempt reconnect even if disconnect fails
            const errMsg = disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr);
            dbg(`Warning: Disconnect failed during reconnect: ${errMsg} - continuing with reconnect anyway`);
          }

          // Wait longer before reconnecting to allow rig to fully clean up old connection
          // This is critical - rig may report CONNINFO busy=true if we reconnect too quickly
          dbg('Full reconnect: waiting 5s for rig to clean up old session...');
          await this.sleep(5000);

          // Reconnect with timeout (uses new state-machine-based connect())
          dbg('Full reconnect: reconnecting');
          await this.connectWithTimeout(30000);

          // Success! Calculate downtime and emit connectionRestored event
          const downtime = Date.now() - disconnectTime;
          dbg(`Full reconnect successful! Downtime: ${downtime}ms`);

          const finalState = this.getConnectionState();
          dbg(`Reconnect complete - All sessions: Control=${finalState.control}, CIV=${finalState.civ}, Audio=${finalState.audio}`);

          // Emit connectionRestored event (fixes Problem #5)
          this.ev.emit('connectionRestored', {
            sessionType: SessionType.CONTROL,
            downtime,
            timestamp: Date.now()
          });

          // State is already CONNECTED from connect() call
          return;

        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          dbg('Full reconnect failed:', errorMsg);

          // Get current connection state for diagnostics
          const state = this.getConnectionState();
          dbg(`Current state after failed reconnect: Control=${state.control}, CIV=${state.civ}, Audio=${state.audio}`);

          // Check if we should retry
          const maxAttempts = this.monitorConfig.maxReconnectAttempts;
          const willRetry = maxAttempts === undefined || attempt < maxAttempts;

          // Emit reconnect failed event
          this.ev.emit('reconnectFailed', {
            sessionType: SessionType.CONTROL,
            attemptNumber: attempt,
            error: errorMsg,
            timestamp: Date.now(),
            fullReconnect: true,
            willRetry,
            nextRetryDelay: willRetry ? this.calculateReconnectDelay(attempt + 1) : undefined
          });

          if (!willRetry) {
            dbg(`Max reconnect attempts (${maxAttempts}) reached, giving up`);
            dbg(`Final state: Control=${state.control}, CIV=${state.civ}, Audio=${state.audio}`);
            // Transition to IDLE since we're giving up
            this.transitionTo(ConnectionPhase.IDLE, 'Max reconnect attempts reached');
            return;
          }

          // Continue loop for retry
          dbg(`Will retry in ${this.calculateReconnectDelay(attempt + 1)}ms...`);
        }
      }
    } catch (err) {
      // Unexpected error in reconnect loop
      dbg('Unexpected error in scheduleFullReconnect:', err);
      this.transitionTo(ConnectionPhase.IDLE, 'Reconnect loop error');
    }
  }

  /**
   * Connect with timeout (helper for reconnection)
   * @private
   */
  private async connectWithTimeout(timeout: number): Promise<void> {
    const timeoutPromise = this.sleep(timeout).then(() => {
      throw new Error(`Connection timeout after ${timeout}ms`);
    });

    await Promise.race([
      this.connect(),
      timeoutPromise
    ]);
  }

  /**
   * Sleep helper (returns a Promise)
   * @private
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Calculate reconnect delay using exponential backoff
   * @private
   */
  private calculateReconnectDelay(attemptNumber: number): number {
    const delay = this.monitorConfig.reconnectBaseDelay * Math.pow(2, attemptNumber - 1);
    return Math.min(delay, this.monitorConfig.reconnectMaxDelay);
  }

  // ============================================================================
  // Public Observability APIs
  // ============================================================================

  /**
   * Get current connection phase
   * @returns Current connection phase (IDLE, CONNECTING, CONNECTED, etc.)
   */
  getConnectionPhase(): ConnectionPhase {
    return this.connectionSession.phase;
  }

  /**
   * Get detailed connection metrics for monitoring and diagnostics
   * @returns Connection metrics including phase, uptime, session states
   */
  getConnectionMetrics(): ConnectionMetrics {
    const now = Date.now();
    return {
      phase: this.connectionSession.phase,
      sessionId: this.connectionSession.sessionId,
      uptime: this.connectionSession.phase === ConnectionPhase.CONNECTED
        ? now - this.connectionSession.startTime
        : 0,
      sessions: this.getConnectionState(),
      lastDisconnectTime: this.connectionSession.lastDisconnectTime,
      isReconnecting: this.connectionSession.phase === ConnectionPhase.RECONNECTING
    };
  }
}
