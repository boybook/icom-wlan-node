import { EventEmitter } from 'events';
import { CapCapabilitiesPacket, Cmd, ControlPacket, LoginPacket, LoginResponsePacket, RadioCapPacket, Sizes, StatusPacket, TokenPacket, TokenType, ConnInfoPacket, AUDIO_SAMPLE_RATE, XIEGU_TX_BUFFER_SIZE, PingPacket, CivPacket } from '../core/IcomPackets';
import { dbg, dbgV } from '../utils/debug';
import { Session } from '../core/Session';
import { IcomRigEvents, IcomRigOptions, LoginResult, StatusInfo, CapabilitiesInfo, RigEventEmitter, IcomMode, ConnectorDataMode, SetModeOptions, QueryOptions, SwrReading, AlcReading, WlanLevelReading } from '../types';
import { IcomCiv } from './IcomCiv';
import { IcomAudio } from './IcomAudio';
import { IcomRigCommands } from './IcomRigCommands';
import { getModeCode, getConnectorModeCode, DEFAULT_CONTROLLER_ADDR, METER_THRESHOLDS, METER_TIMER_PERIOD_MS } from './IcomConstants';
import { parseTwoByteBcd } from '../utils/bcd';

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

  // Connection readiness promises
  private loginReady!: Promise<void>;
  private civReady!: Promise<void>;
  private audioReady!: Promise<void>;
  private resolveLoginReady!: () => void;
  private resolveCivReady!: () => void;
  private resolveAudioReady!: () => void;

  constructor(options: IcomRigOptions) {
    this.options = options;
    this.sess = new Session({ ip: options.control.ip, port: options.control.port }, {
      onData: (data) => this.onData(data),
      onSendError: (e) => this.ev.emit('error', e)
    });
    // Pre-open local CIV/Audio sessions to obtain local ports before 0x90
    this.civSess = new Session({ ip: options.control.ip, port: 0 }, { onData: (b) => this.onCivData(b), onSendError: (e) => this.ev.emit('error', e) });
    this.audioSess = new Session({ ip: options.control.ip, port: 0 }, { onData: (b) => this.onAudioData(b), onSendError: (e) => this.ev.emit('error', e) });
    this.civSess.open();
    this.audioSess.open();
    this.civ = new IcomCiv(this.civSess);
    this.audio = new IcomAudio(this.audioSess);
  }

  get events(): RigEventEmitter { return this.ev; }

  async connect() {
    // Initialize readiness promises
    this.loginReady = new Promise<void>(resolve => { this.resolveLoginReady = resolve; });
    this.civReady = new Promise<void>(resolve => { this.resolveCivReady = resolve; });
    this.audioReady = new Promise<void>(resolve => { this.resolveAudioReady = resolve; });

    this.sess.open();
    this.sess.startAreYouThere();

    // Wait for all sub-sessions to be ready
    await Promise.all([this.loginReady, this.civReady, this.audioReady]);
    dbg('All sessions ready (login + civ + audio)');
  }

  async disconnect() {
    // 1. Stop all timers first to prevent interference
    if (this.tokenTimer) { clearInterval(this.tokenTimer); this.tokenTimer = undefined; }
    this.stopMeterPolling();
    this.sess.stopTimers();
    if (this.civSess) this.civSess.stopTimers();
    if (this.audioSess) this.audioSess.stopTimers();

    // 2. Send DELETE token packet
    const del = TokenPacket.build(0, this.sess.localId, this.sess.remoteId, TokenType.DELETE, this.sess.innerSeq, this.sess.localToken, this.sess.rigToken);
    this.sess.innerSeq = (this.sess.innerSeq + 1) & 0xffff;
    this.sess.sendTracked(del);

    // 3. Send CMD_DISCONNECT to all sessions
    this.sess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.sess.localId, this.sess.remoteId));
    if (this.civSess) {
      this.civ.sendOpenClose(false);
      this.civSess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.civSess.localId, this.civSess.remoteId));
    }
    if (this.audioSess) {
      this.audioSess.sendUntracked(ControlPacket.toBytes(Cmd.DISCONNECT, 0, this.audioSess.localId, this.audioSess.remoteId));
    }

    // 4. Wait 200ms to ensure UDP packets are sent before closing sockets
    await new Promise(resolve => setTimeout(resolve, 200));

    // 5. Stop streams and close sockets
    this.civ.stop();
    this.audio.stop(); // Stop continuous audio transmission
    this.sess.close();
    if (this.civSess) this.civSess.close();
    if (this.audioSess) this.audioSess.close();
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
        dbg('STATUS <= civPort=', civPort, 'audioPort=', audioPort, 'authOK=', StatusPacket.authOK(buf), 'connected=', StatusPacket.getIsConnected(buf));
        const info: StatusInfo = { civPort, audioPort, authOK: true, connected: true };
        this.ev.emit('status', info);
        // set remote ports and start AYT for civ/audio
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
        if (ok) {
          dbg('Login ready - resolving loginReady promise');
          this.resolveLoginReady();
        }
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
        const busy = ConnInfoPacket.getBusy(buf);
        this.macAddress = ConnInfoPacket.getMacAddress(buf);
        this.rigName = ConnInfoPacket.getRigName(buf);
        dbg('CONNINFO <= busy=', busy, 'rigName=', this.rigName);
        if (!busy) {
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
        }
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
        dbg('CIV ready - resolving civReady promise');
        this.resolveCivReady();
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
        dbg('Audio ready - started continuous audio stream, resolving audioReady promise');
        this.resolveAudioReady();
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
}
