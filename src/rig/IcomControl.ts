import { EventEmitter } from 'events';
import { CapCapabilitiesPacket, Cmd, ControlPacket, LoginPacket, LoginResponsePacket, RadioCapPacket, Sizes, StatusPacket, TokenPacket, TokenType, ConnInfoPacket, AUDIO_SAMPLE_RATE, XIEGU_TX_BUFFER_SIZE, PingPacket, CivPacket } from '../core/IcomPackets';
import { dbg, dbgV } from '../utils/debug';
import { Session } from '../core/Session';
import { IcomRigEvents, IcomRigOptions, LoginResult, StatusInfo, CapabilitiesInfo, RigEventEmitter, IcomMode, ConnectorDataMode, SetModeOptions, QueryOptions, SwrReading, AlcReading, WlanLevelReading, LevelMeterReading, SquelchStatusReading, AudioSquelchReading, OvfStatusReading, PowerLevelReading, CompLevelReading, VoltageReading, CurrentReading, SessionType, ConnectionState, ConnectionLostInfo, ConnectionRestoredInfo, ConnectionMonitorConfig, ReconnectAttemptInfo, ReconnectFailedInfo, ConnectionPhase, ConnectionSession, ConnectionMetrics, DisconnectReason, DisconnectOptions, TunerStatusReading, TunerState } from '../types';
import { IcomCiv } from './IcomCiv';
import { IcomAudio } from './IcomAudio';
import { IcomRigCommands } from './IcomRigCommands';
import { getModeCode, getConnectorModeCode, DEFAULT_CONTROLLER_ADDR, METER_THRESHOLDS, METER_TIMER_PERIOD_MS, rawToPowerPercent, rawToVoltage, rawToCurrent } from './IcomConstants';
import { parseTwoByteBcd } from '../utils/bcd';
import { ConnectionAbortedError, getDisconnectMessage } from '../utils/errors';
import { rawToSMeter } from '../utils/smeter';

export class IcomControl {
  private ev: RigEventEmitter = new EventEmitter() as RigEventEmitter;
  private sess: Session; // control
  private civSess: Session;
  private audioSess: Session;
  public civ: IcomCiv;
  public audio: IcomAudio;
  private options: IcomRigOptions;
  private rigName = '';
  private macAddress: Buffer = Buffer.alloc(6);
  private tokenTimer?: NodeJS.Timeout;
  private civAssembleBuf: Buffer = Buffer.alloc(0); // CIV stream reassembler
  private meterTimer?: NodeJS.Timeout;

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
    this.options = options;

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
  }

  get events(): RigEventEmitter { return this.ev; }

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
    this.sendCiv(IcomRigCommands.setFrequency(ctrAddr, rigAddr, hz));
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

    if (options?.dataMode) {
      this.sendCiv(IcomRigCommands.setOperationDataMode(ctrAddr, rigAddr, modeCode));
    } else {
      this.sendCiv(IcomRigCommands.setMode(ctrAddr, rigAddr, modeCode));
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
    const req = IcomRigCommands.readOperatingFrequency(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame((frame) => IcomControl.isReplyOf(frame, 0x03, ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));
    if (!resp) return null;
    const freq = IcomControl.parseIcomFreqFromReply(resp);
    return freq;
  }

  /**
   * Read current operating mode and filter
   * @returns { mode: number, filter?: number } or null
   */
  async readOperatingMode(options?: QueryOptions): Promise<{ mode: number; filter?: number; modeName?: string; filterName?: string } | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readOperatingMode(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      (frame) => IcomControl.matchCommandFrame(frame, 0x04, [], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Expect FE FE [ctr] [rig] 0x04 [mode] [filter] FD (some rigs may omit filter)
    const mode = resp.length > 5 ? resp[5] : undefined;
    const filter = resp.length > 6 ? resp[6] : undefined;
    if (mode === undefined) return null;
    // Map names using constants
    const { getModeString, getFilterString } = await import('./IcomConstants');
    const modeName = getModeString(mode);
    const filterName = getFilterString(filter);
    return { mode, filter, modeName, filterName };
  }

  /**
   * Read current transmit frequency (when TX)
   */
  async readTransmitFrequency(options?: QueryOptions): Promise<number | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readTransmitFrequency(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      (frame) => IcomControl.matchCommandFrame(frame, 0x1c, [0x03], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Parse BCD like readOperatingFrequency, but starting after [0x1c, 0x03]
    // Find 0x1c position and read next 2 bytes (0x03 + 5 BCD bytes)
    let idx = resp.indexOf(0x1c, 4);
    if (idx < 0 || idx + 6 >= resp.length) idx = 4;
    if (idx + 6 >= resp.length) return null;
    // After 0x1c 0x03, we expect 5 BCD bytes
    if (resp[idx + 1] !== 0x03) return null;
    const d0 = resp[idx + 2];
    const d1 = resp[idx + 3];
    const d2 = resp[idx + 4];
    const d3 = resp[idx + 5];
    const d4 = resp[idx + 6];
    const bcdToInt = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
    const v0 = bcdToInt(d0);
    const v1 = bcdToInt(d1);
    const v2 = bcdToInt(d2);
    const v3 = bcdToInt(d3);
    const v4 = bcdToInt(d4);
    const hz = v0 + v1 * 100 + v2 * 10000 + v3 * 1000000 + v4 * 100000000;
    return hz;
  }

  /**
   * Read transceiver state (TX/RX) via 0x1A 0x00 0x48
   * Note: Java comments mark this as not recommended; use with caution.
   */
  async readTransceiverState(options?: QueryOptions): Promise<'TX' | 'RX' | 'UNKNOWN' | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.readTransceiverState(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      (frame) => IcomControl.matchCommandFrame(frame, 0x1a, [0x00, 0x48], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Heuristic: take first data byte after subcmd2 as state
    const pos = 5 + 2; // after 0x1a [0x00,0x48]
    const state = resp.length > pos ? resp[pos] : undefined;
    if (state === undefined) return 'UNKNOWN';
    if (state === 0x01) return 'TX';
    if (state === 0x00) return 'RX';
    return 'UNKNOWN';
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
      (frame) => IcomControl.isMeterReply(frame, 0x12, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      swr: raw / 100,
      alert: raw >= METER_THRESHOLDS.SWR_ALERT
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
      (frame) => IcomControl.isMeterReply(frame, 0x13, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      percent: (raw / METER_THRESHOLDS.ALC_MAX) * 100,
      alert: raw > METER_THRESHOLDS.ALC_ALERT_MAX
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
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getConnectorWLanLevel(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame((frame) => IcomControl.matchCommandFrame(frame, 0x1a, [0x05, 0x01, 0x17], ctrAddr, rigAddr), timeoutMs, () => this.sendCiv(req));

    const raw = IcomControl.extractMeterData(resp);
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
      (frame) => IcomControl.isMeterReply(frame, 0x02, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    const data = resp.subarray(6, resp.length - 1);
    if (data.length === 0) return null;
    const raw = data[data.length - 1] & 0xff; // use low byte as 0-255 level

    // Convert raw value to S-meter reading with physical units
    // Uses IC-705 calibration by default (can be extended to support other models)
    return rawToSMeter(raw, 'IC-705');
  }

  /**
   * Set WLAN connector audio level
   * @param level - Audio level (0-255)
   */
  async setConnectorWLanLevel(level: number): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setConnectorWLanLevel(ctrAddr, rigAddr, level));
  }

  /**
   * Set connector data routing mode
   * @param mode - Data routing mode (MIC, ACC, USB, WLAN)
   * @example
   * // Route audio to WLAN
   * await rig.setConnectorDataMode('WLAN');
   */
  async setConnectorDataMode(mode: ConnectorDataMode | number): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const modeCode = typeof mode === 'string' ? getConnectorModeCode(mode) : mode;
    this.sendCiv(IcomRigCommands.setConnectorDataMode(ctrAddr, rigAddr, modeCode));
  }

  /**
   * ==============================
   * Antenna Tuner (ATU) Operations
   * ==============================
   */

  /**
   * Read antenna tuner status (CI-V 0x1A/0x00)
   * 00=OFF, 01=ON, 02=TUNING
   */
  async readTunerStatus(options?: QueryOptions): Promise<TunerStatusReading | null> {
    const timeoutMs = options?.timeout ?? 3000;
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    const req = IcomRigCommands.getTunerStatus(ctrAddr, rigAddr);
    const resp = await this.waitForCivFrame(
      (frame) => IcomControl.matchCommandFrame(frame, 0x1a, [0x00], ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );
    if (!resp) return null;
    // Expect FE FE [ctr] [rig] 0x1A 0x00 [status] FD
    const raw = resp.length > 6 ? (resp[6] & 0xff) : undefined;
    if (raw === undefined) return null;
    const state: TunerState = raw === 0x00 ? 'OFF' : raw === 0x01 ? 'ON' : raw === 0x02 ? 'TUNING' : 'OFF';
    return { raw, state };
  }

  /**
   * Enable or disable internal antenna tuner (CI-V 0x1A/0x01)
   * @param enabled true to enable, false to disable
   */
  async setTunerEnabled(enabled: boolean): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.setTunerEnabled(ctrAddr, rigAddr, enabled));
  }

  /**
   * Start a manual tuning cycle (same as [TUNE] key) (CI-V 0x1A/0x02/0x00)
   */
  async startManualTune(): Promise<void> {
    const ctrAddr = DEFAULT_CONTROLLER_ADDR;
    const rigAddr = this.civ.civAddress & 0xff;
    this.sendCiv(IcomRigCommands.startManualTune(ctrAddr, rigAddr));
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
      (frame) => IcomControl.isMeterReply(frame, 0x11, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      percent: rawToPowerPercent(raw)
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
      (frame) => IcomControl.isMeterReply(frame, 0x14, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      percent: (raw / 255) * 100
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
      (frame) => IcomControl.isMeterReply(frame, 0x15, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      volts: rawToVoltage(raw)
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
      (frame) => IcomControl.isMeterReply(frame, 0x16, ctrAddr, rigAddr),
      timeoutMs,
      () => this.sendCiv(req)
    );

    const raw = IcomControl.extractMeterData(resp);
    if (raw === null) return null;

    return {
      raw,
      amps: rawToCurrent(raw)
    };
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
    // Extract 2-byte BCD data at position 6-7 of the CI-V frame (FE FE [ctr] [rig] 0x15 [sub] [b0] [b1] FD)
    const bcdData = frame.subarray(6, 8);
    return parseTwoByteBcd(bcdData);
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

  // Parse CI-V reply for command 0x03 (read operating frequency)
  static parseIcomFreqFromReply(frame: Buffer): number | null {
    // Expect: FE FE [ctr] [rig] 0x03 [bcd0..bcd4] FD
    if (!(frame && frame.length >= 7)) return null;
    if (frame[0] !== 0xfe || frame[1] !== 0xfe) return null;
    if (frame[4] !== 0x03) return null;
    // Some radios may include extra bytes; find 0x03 and read next 5 bytes
    let idx = frame.indexOf(0x03, 5);
    if (idx < 0 || idx + 5 >= frame.length) idx = 4; // fallback to standard position
    if (idx + 5 >= frame.length) return null;
    const d0 = frame[idx + 1];
    const d1 = frame[idx + 2];
    const d2 = frame[idx + 3];
    const d3 = frame[idx + 4];
    const d4 = frame[idx + 5];
    const bcdToInt = (b: number) => ((b >> 4) & 0x0f) * 10 + (b & 0x0f);
    const v0 = bcdToInt(d0);
    const v1 = bcdToInt(d1);
    const v2 = bcdToInt(d2);
    const v3 = bcdToInt(d3);
    const v4 = bcdToInt(d4);
    const hz = v0 + v1 * 100 + v2 * 10000 + v3 * 1000000 + v4 * 100000000;
    return hz;
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
          if (info.civAddress != null) this.civ.civAddress = info.civAddress;
          if (info.supportTX != null) this.civ.supportTX = info.supportTX;
          dbgV('CAP <= civAddr=', info.civAddress, 'audioName=', info.audioName, 'supportTX=', info.supportTX);
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
        dbg('CONNINFO <= busy=', busy, 'rigName=', this.rigName);

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
      // Continue loop in case multiple frames are in buffer
    }
  }

  // Wait for single CI-V frame that matches predicate (fed by civFrame event)
  private async waitForCivFrame(predicate: (frame: Buffer) => boolean, timeoutMs: number, onSend?: () => void): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      let done = false;
      const onFrame = (frame: Buffer) => {
        if (!done && predicate(frame)) {
          done = true;
          this.ev.off('civFrame', onFrame as any);
          resolve(frame);
        }
      };
      this.ev.on('civFrame', onFrame as any);
      if (onSend) onSend();
      setTimeout(() => {
        if (!done) {
          this.ev.off('civFrame', onFrame as any);
          resolve(null);
        }
      }, timeoutMs);
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
        this.ev.emit('audio', { pcm16: audio });
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
