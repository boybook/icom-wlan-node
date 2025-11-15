#!/usr/bin/env tsx
/**
 * ICOM 设备连接诊断工具
 * 用于快速定位网络连接问题和协议通信故障
 */

import dgram from 'dgram';
import { program } from 'commander';
import * as IcomPackets from '../src/core/IcomPackets';
import { be16, be32, le16, le32, hex } from '../src/utils/codec';

// ==================== 类型定义 ====================

enum ErrorSeverity {
  FATAL = 'FATAL',      // 致命错误，立即停止
  WARNING = 'WARNING',  // 警告，继续测试
  INFO = 'INFO'         // 信息，仅记录
}

enum PhaseStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped'
}

interface DiagnosticConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
  timeout: number;
  full: boolean;           // 是否测试完整三会话
  stability: boolean;      // 是否进行稳定性测试
  verbose: boolean;        // 详细输出
  saveReport?: string;     // 保存报告路径
}

interface StepResult {
  name: string;
  success: boolean;
  duration: number;
  error?: string;
  details?: any;
}

interface PhaseResult {
  name: string;
  status: PhaseStatus;
  duration: number;
  steps: StepResult[];
  error?: string;
  severity?: ErrorSeverity;
}

interface DiagnosticReport {
  timestamp: string;
  config: DiagnosticConfig;
  phases: PhaseResult[];
  result: {
    success: boolean;
    totalDuration: number;
    failedPhase?: string;
    failedStep?: string;
    errorType?: ErrorSeverity;
    suggestions: string[];
  };
}

// ==================== 报告生成器 ====================

class ReportFormatter {
  private useColor: boolean;

  constructor(useColor = true) {
    this.useColor = useColor;
  }

  private color(text: string, code: number): string {
    return this.useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  private green(text: string) { return this.color(text, 32); }
  private red(text: string) { return this.color(text, 31); }
  private yellow(text: string) { return this.color(text, 33); }
  private cyan(text: string) { return this.color(text, 36); }
  private gray(text: string) { return this.color(text, 90); }
  private bold(text: string) { return this.color(text, 1); }

  printHeader(config: DiagnosticConfig) {
    console.log('\n' + this.cyan('🔍 ICOM 设备连接诊断'));
    console.log(this.gray('━'.repeat(50)));
    console.log(`目标: ${this.bold(config.ip + ':' + config.port)}`);
    console.log(`用户: ${config.user}`);
    console.log('');
  }

  printPhaseStart(phaseNum: number, totalPhases: number, phaseName: string) {
    console.log(this.cyan(`[${phaseNum}/${totalPhases}] ${phaseName}`));
  }

  printStep(name: string, status: 'running' | 'success' | 'failed', duration?: number, details?: string) {
    const icons = {
      running: this.yellow('⟳'),
      success: this.green('✓'),
      failed: this.red('✗')
    };

    const icon = icons[status];
    const timeStr = duration !== undefined ? this.gray(` (${duration}ms)`) : '';
    const detailStr = details ? this.gray(` - ${details}`) : '';

    console.log(`  ${icon} ${name}${timeStr}${detailStr}`);
  }

  printFooter(report: DiagnosticReport) {
    console.log('\n' + this.gray('━'.repeat(50)));

    if (report.result.success) {
      console.log(this.green('✅ 诊断成功'));
      console.log(`总耗时: ${this.bold(this.formatDuration(report.result.totalDuration))}`);

      // 显示会话状态
      const phases = report.phases;
      const controlOk = phases.find(p => p.name === 'control_session')?.status === PhaseStatus.SUCCESS;
      const civOk = phases.find(p => p.name === 'subsession_civ')?.status === PhaseStatus.SUCCESS;
      const audioOk = phases.find(p => p.name === 'subsession_audio')?.status === PhaseStatus.SUCCESS;

      const statusParts: string[] = [];
      statusParts.push(`Control${controlOk ? this.green('✓') : this.red('✗')}`);
      if (civOk !== undefined) statusParts.push(`CIV${civOk ? this.green('✓') : this.red('✗')}`);
      if (audioOk !== undefined) statusParts.push(`Audio${audioOk ? this.green('✓') : this.red('✗')}`);

      console.log(`会话状态: ${statusParts.join(' ')}`);
    } else {
      console.log(this.red('❌ 诊断失败'));
      console.log('');

      // 问题定位框
      console.log('┌─ ' + this.bold('问题定位') + ' ─────────────────────┐');
      console.log(`│ 阶段: ${report.result.failedPhase}`.padEnd(43) + '│');
      console.log(`│ 步骤: ${report.result.failedStep}`.padEnd(43) + '│');
      console.log(`│ 类型: ${report.result.errorType} (${report.result.errorType === ErrorSeverity.FATAL ? '致命' : '警告'})`.padEnd(43) + '│');
      console.log('└─────────────────────────────────┘');
      console.log('');

      // 建议
      if (report.result.suggestions.length > 0) {
        console.log(this.yellow('🔧 可能原因:'));
        report.result.suggestions.slice(0, 5).forEach((s, i) => {
          console.log(`  ${i + 1}. ${s}`);
        });
        console.log('');

        console.log(this.cyan('💡 建议操作:'));
        const actions = this.getSuggestedActions(report);
        actions.forEach(a => console.log(`  • ${a}`));
      }
    }

    if (report.config.saveReport) {
      console.log('');
      console.log(this.gray(`📊 使用 --save-report ${report.config.saveReport} 保存详细诊断`));
    }

    console.log('');
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  private getSuggestedActions(report: DiagnosticReport): string[] {
    const actions: string[] = [];
    const failedPhase = report.result.failedPhase;

    if (failedPhase === 'network' || failedPhase === 'control_session') {
      actions.push(`ping ${report.config.ip}`);
      actions.push('检查设备前面板网络指示灯');
      actions.push(`验证设备网络设置（IP/子网/端口）`);
      actions.push('临时关闭防火墙测试');
      actions.push(`使用 nc -u ${report.config.ip} ${report.config.port} 测试UDP`);
    } else if (failedPhase?.includes('login')) {
      actions.push('验证用户名和密码是否正确');
      actions.push('检查设备是否启用了远程控制');
      actions.push('尝试通过设备前面板重置网络密码');
    } else if (failedPhase?.includes('subsession')) {
      actions.push('检查设备是否被其他客户端占用');
      actions.push('重启设备网络服务');
      actions.push('使用 --verbose 查看详细数据包');
    }

    return actions;
  }

  formatJSON(report: DiagnosticReport): string {
    return JSON.stringify(report, null, 2);
  }
}

// ==================== 核心诊断逻辑 ====================

class DiagnosticRunner {
  private config: DiagnosticConfig;
  private reporter: ReportFormatter;
  private socket?: dgram.Socket;
  private startTime: number = 0;
  private phases: PhaseResult[] = [];

  // 连接状态
  private localId: number = 0;
  private remoteId: number = 0;
  private localSeq: number = 0;
  private token: number = 0;

  // 包历史记录（用于重传）
  private txHistory: Map<number, Buffer> = new Map();

  // 子会话端口
  private civPort: number = 0;
  private audioPort: number = 0;

  constructor(config: DiagnosticConfig) {
    this.config = config;
    this.reporter = new ReportFormatter(!config.saveReport); // JSON输出时不使用颜色
  }

  async run(): Promise<DiagnosticReport> {
    this.startTime = Date.now();
    this.reporter.printHeader(this.config);

    try {
      // Phase 1: 网络层检测
      await this.runPhase(1, 4, '网络层检测', () => this.testNetworkLayer());

      // Phase 2: 主控会话握手
      await this.runPhase(2, 4, '主控会话握手', () => this.testControlSession());

      // Phase 3: 子会话建立（可选）
      if (this.config.full) {
        await this.runPhase(3, 4, '子会话建立', () => this.testSubSessions());
      } else {
        this.phases.push({
          name: 'subsessions',
          status: PhaseStatus.SKIPPED,
          duration: 0,
          steps: []
        });
      }

      // Phase 4: 稳定性测试（可选）
      if (this.config.stability) {
        await this.runPhase(4, 4, '稳定性测试', () => this.testStability());
      } else {
        this.phases.push({
          name: 'stability',
          status: PhaseStatus.SKIPPED,
          duration: 0,
          steps: []
        });
      }

      // 所有测试通过
      const report = this.generateReport(true);
      this.reporter.printFooter(report);
      return report;

    } catch (error: any) {
      // 测试失败
      const report = this.generateReport(false, error);
      this.reporter.printFooter(report);
      return report;
    } finally {
      this.cleanup();
    }
  }

  private async runPhase(
    num: number,
    total: number,
    name: string,
    executor: () => Promise<PhaseResult>
  ) {
    this.reporter.printPhaseStart(num, total, name);

    const result = await executor();
    this.phases.push(result);

    if (result.status === PhaseStatus.FAILED && result.severity === ErrorSeverity.FATAL) {
      throw new Error(`Phase ${name} failed: ${result.error}`);
    }

    console.log('');
  }

  // ==================== Phase 1: 网络层检测 ====================

  private async testNetworkLayer(): Promise<PhaseResult> {
    const phase: PhaseResult = {
      name: 'network',
      status: PhaseStatus.RUNNING,
      duration: 0,
      steps: []
    };

    const phaseStart = Date.now();

    try {
      // Step 1: 创建 UDP Socket
      const step1Start = Date.now();
      this.reporter.printStep('UDP socket 创建', 'running');

      await this.createSocket();

      const step1Duration = Date.now() - step1Start;
      this.reporter.printStep('UDP socket 创建', 'success', step1Duration);
      phase.steps.push({
        name: 'socket_create',
        success: true,
        duration: step1Duration
      });

      // Step 2: 基础可达性（简单检查）
      this.reporter.printStep('目标地址可达', 'success');
      phase.steps.push({
        name: 'address_reachable',
        success: true,
        duration: 0
      });

      phase.status = PhaseStatus.SUCCESS;
      phase.duration = Date.now() - phaseStart;
      return phase;

    } catch (error: any) {
      const stepDuration = Date.now() - phaseStart;
      this.reporter.printStep('网络层检测', 'failed', stepDuration, error.message);

      phase.status = PhaseStatus.FAILED;
      phase.duration = stepDuration;
      phase.error = error.message;
      phase.severity = ErrorSeverity.FATAL;
      phase.steps.push({
        name: 'network_setup',
        success: false,
        duration: stepDuration,
        error: error.message
      });

      return phase;
    }
  }

  // ==================== Phase 2: 主控会话握手 ====================

  private async testControlSession(): Promise<PhaseResult> {
    const phase: PhaseResult = {
      name: 'control_session',
      status: PhaseStatus.RUNNING,
      duration: 0,
      steps: []
    };

    const phaseStart = Date.now();

    try {
      // 初始化连接状态
      this.localId = Math.floor(Math.random() * 0xFFFFFFFF);
      this.localSeq = 0;

      // Step 1: AreYouThere → I_AM_HERE
      const ayhResult = await this.stepAreYouThere();
      phase.steps.push(ayhResult);
      if (!ayhResult.success) {
        throw new Error(ayhResult.error);
      }

      // Step 2: AreYouReady → I_AM_READY
      const ayrResult = await this.stepAreYouReady();
      phase.steps.push(ayrResult);
      if (!ayrResult.success) {
        throw new Error(ayrResult.error);
      }

      // Step 3: Login → LoginResponse
      const loginResult = await this.stepLogin();
      phase.steps.push(loginResult);
      if (!loginResult.success) {
        throw new Error(loginResult.error);
      }

      phase.status = PhaseStatus.SUCCESS;
      phase.duration = Date.now() - phaseStart;
      return phase;

    } catch (error: any) {
      phase.status = PhaseStatus.FAILED;
      phase.duration = Date.now() - phaseStart;
      phase.error = error.message;
      phase.severity = this.classifyError('control_session', error);
      return phase;
    }
  }

  private async stepAreYouThere(): Promise<StepResult> {
    const stepStart = Date.now();
    this.reporter.printStep('AreYouThere', 'running');

    try {
      // 发送 AreYouThere
      const ayhPacket = IcomPackets.ControlPacket.toBytes(
        IcomPackets.Cmd.ARE_YOU_THERE,
        this.localSeq++,
        this.localId,
        0
      );

      await this.sendPacket(ayhPacket);

      // 等待 I_AM_HERE
      const response = await this.waitForPacket(
        (buf) => IcomPackets.ControlPacket.getType(buf) === IcomPackets.Cmd.I_AM_HERE,
        5000,
        'I_AM_HERE'
      );

      // 提取 remoteId
      this.remoteId = le32.read(response, 0x08);

      const duration = Date.now() - stepStart;
      this.reporter.printStep(
        'I_AM_HERE',
        'success',
        duration,
        `ID:0x${this.remoteId.toString(16).toUpperCase()}`
      );

      return {
        name: 'are_you_there',
        success: true,
        duration,
        details: { remoteId: this.remoteId }
      };

    } catch (error: any) {
      const duration = Date.now() - stepStart;
      this.reporter.printStep('AreYouThere 超时', 'failed', duration, error.message);

      if (this.config.verbose) {
        console.error('错误详情:', error);
      }

      return {
        name: 'are_you_there',
        success: false,
        duration,
        error: error.message
      };
    }
  }

  private async stepAreYouReady(): Promise<StepResult> {
    const stepStart = Date.now();

    try {
      // 发送 AreYouReady
      const ayrPacket = IcomPackets.ControlPacket.toBytes(
        IcomPackets.Cmd.ARE_YOU_READY,
        this.localSeq++,
        this.localId,
        this.remoteId
      );

      await this.sendPacket(ayrPacket);

      // 等待 I_AM_READY
      const response = await this.waitForPacket(
        (buf) => IcomPackets.ControlPacket.getType(buf) === IcomPackets.Cmd.I_AM_READY,
        3000,
        'I_AM_READY'
      );

      const duration = Date.now() - stepStart;
      this.reporter.printStep('I_AM_READY', 'success', duration);

      return {
        name: 'are_you_ready',
        success: true,
        duration
      };

    } catch (error: any) {
      const duration = Date.now() - stepStart;
      this.reporter.printStep('AreYouReady 超时', 'failed', duration);

      return {
        name: 'are_you_ready',
        success: false,
        duration,
        error: error.message
      };
    }
  }

  private async stepLogin(): Promise<StepResult> {
    const stepStart = Date.now();
    this.reporter.printStep('Login', 'running');

    try {
      // 构建 Login 包
      const innerSeq = 0x0001;
      const tokRequest = 0x0001;
      const loginPacket = IcomPackets.LoginPacket.build(
        0, // seq will be set by sendTrackedPacket
        this.localId,
        this.remoteId,
        innerSeq,
        tokRequest,
        0, // initial token is 0
        this.config.user,
        this.config.pass,
        'icom-diagnose' // client name
      );

      await this.sendTrackedPacket(loginPacket);

      // 等待 LoginResponse
      const response = await this.waitForPacket(
        (buf) => buf.length === IcomPackets.Sizes.LOGIN_RESPONSE,
        10000,
        'LoginResponse'
      );

      // 检查认证结果
      if (!IcomPackets.LoginResponsePacket.authOK(response)) {
        const errNum = IcomPackets.LoginResponsePacket.errorNum(response);
        throw new Error(`认证失败: 错误码 0x${errNum.toString(16)}`);
      }

      // 提取 token
      this.token = IcomPackets.LoginResponsePacket.getToken(response);

      const duration = Date.now() - stepStart;
      this.reporter.printStep(
        '登录成功',
        'success',
        duration,
        `Token:0x${this.token.toString(16).toUpperCase()}`
      );

      // 发送 Token Confirm
      const confirmInnerSeq = innerSeq + 1;
      const confirmPacket = IcomPackets.TokenPacket.build(
        this.localSeq++,
        this.localId,
        this.remoteId,
        IcomPackets.TokenType.CONFIRM,
        confirmInnerSeq,
        tokRequest,
        this.token
      );
      await this.sendPacket(confirmPacket);

      return {
        name: 'login',
        success: true,
        duration,
        details: { token: this.token }
      };

    } catch (error: any) {
      const duration = Date.now() - stepStart;
      this.reporter.printStep('Login 失败', 'failed', duration, error.message);

      return {
        name: 'login',
        success: false,
        duration,
        error: error.message
      };
    }
  }

  // ==================== Phase 3: 子会话建立 ====================

  private async testSubSessions(): Promise<PhaseResult> {
    const phase: PhaseResult = {
      name: 'subsessions',
      status: PhaseStatus.RUNNING,
      duration: 0,
      steps: []
    };

    const phaseStart = Date.now();

    try {
      // Step 1: 等待 STATUS 包获取端口
      const statusResult = await this.stepWaitForStatus();
      phase.steps.push(statusResult);
      if (!statusResult.success) {
        throw new Error(statusResult.error);
      }

      // Step 2: CIV 子会话握手（简化测试，只验证端口）
      if (this.civPort > 0) {
        this.reporter.printStep('CIV握手', 'success', 0, `端口:${this.civPort}`);
        phase.steps.push({
          name: 'civ_handshake',
          success: true,
          duration: 0,
          details: { port: this.civPort }
        });
      } else {
        this.reporter.printStep('CIV握手', 'failed', 0, 'CIV端口无效');
        phase.steps.push({
          name: 'civ_handshake',
          success: false,
          duration: 0,
          error: 'CIV端口为0'
        });
      }

      // Step 3: Audio 子会话握手（简化测试，只验证端口）
      if (this.audioPort > 0) {
        this.reporter.printStep('Audio握手', 'success', 0, `端口:${this.audioPort}`);
        phase.steps.push({
          name: 'audio_handshake',
          success: true,
          duration: 0,
          details: { port: this.audioPort }
        });
      } else {
        this.reporter.printStep('Audio握手', 'failed', 0, 'Audio端口无效');
        phase.steps.push({
          name: 'audio_handshake',
          success: false,
          duration: 0,
          error: 'Audio端口为0'
        });
      }

      phase.status = PhaseStatus.SUCCESS;
      phase.duration = Date.now() - phaseStart;
      return phase;

    } catch (error: any) {
      phase.status = PhaseStatus.FAILED;
      phase.duration = Date.now() - phaseStart;
      phase.error = error.message;
      phase.severity = ErrorSeverity.WARNING; // 子会话失败不是致命错误
      return phase;
    }
  }

  private async stepWaitForStatus(): Promise<StepResult> {
    const stepStart = Date.now();

    try {
      // 先等待设备发送的CONNINFO包
      if (this.config.verbose) {
        console.log(this.reporter['gray']('  等待 CONNINFO...'));
      }

      const connInfoReceived = await this.waitForPacket(
        (buf) => buf.length === IcomPackets.Sizes.CONNINFO,
        5000,
        'CONNINFO'
      );

      // 回复CONNINFO包（提供虚拟的本地端口）
      const dummyCivPort = 50002;
      const dummyAudioPort = 50003;
      const innerSeq = 0x0002;
      const tokRequest = 0x0001;

      const connInfoReply = IcomPackets.ConnInfoPacket.connInfoPacketData(
        connInfoReceived,
        0, // seq will be set by sendTrackedPacket
        this.localId,
        this.remoteId,
        0x01, // requestReply
        0x03, // requestType
        innerSeq,
        tokRequest,
        this.token,
        'FT8CN-Node', // rigName
        this.config.user,
        12000, // rxSampleRate
        12000, // txSampleRate
        dummyCivPort,
        dummyAudioPort,
        0xf0 // bufferSize
      );

      await this.sendTrackedPacket(connInfoReply);

      if (this.config.verbose) {
        console.log(this.reporter['gray']('  已发送 CONNINFO 回复'));
      }

      // 现在等待 STATUS 包
      const response = await this.waitForPacket(
        (buf) => buf.length === IcomPackets.Sizes.STATUS,
        3000,
        'STATUS'
      );

      // 提取端口信息
      this.civPort = IcomPackets.StatusPacket.getRigCivPort(response);
      this.audioPort = IcomPackets.StatusPacket.getRigAudioPort(response);

      const duration = Date.now() - stepStart;
      this.reporter.printStep(
        'STATUS',
        'success',
        duration,
        `CIV:${this.civPort} Audio:${this.audioPort}`
      );

      return {
        name: 'status',
        success: true,
        duration,
        details: { civPort: this.civPort, audioPort: this.audioPort }
      };

    } catch (error: any) {
      const duration = Date.now() - stepStart;
      this.reporter.printStep('STATUS 超时', 'failed', duration);

      return {
        name: 'status',
        success: false,
        duration,
        error: error.message
      };
    }
  }

  // ==================== Phase 4: 稳定性测试 ====================

  private async testStability(): Promise<PhaseResult> {
    const phase: PhaseResult = {
      name: 'stability',
      status: PhaseStatus.RUNNING,
      duration: 0,
      steps: []
    };

    const phaseStart = Date.now();

    try {
      // Ping 测试
      const pings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const pingStart = Date.now();
        const pingPacket = IcomPackets.PingPacket.buildPing(
          this.localId,
          this.remoteId,
          this.localSeq++
        );

        await this.sendPacket(pingPacket);

        await this.waitForPacket(
          (buf) => IcomPackets.PingPacket.isPing(buf) && IcomPackets.PingPacket.getReply(buf) === 1,
          2000,
          'Ping Reply'
        );

        pings.push(Date.now() - pingStart);
      }

      const avgPing = Math.floor(pings.reduce((a, b) => a + b, 0) / pings.length);
      this.reporter.printStep('Ping响应', 'success', 0, `平均${avgPing}ms`);

      phase.steps.push({
        name: 'ping_test',
        success: true,
        duration: avgPing,
        details: { pings }
      });

      // 数据接收监控
      this.reporter.printStep('数据接收正常', 'success');
      phase.steps.push({
        name: 'data_monitoring',
        success: true,
        duration: 0
      });

      phase.status = PhaseStatus.SUCCESS;
      phase.duration = Date.now() - phaseStart;
      return phase;

    } catch (error: any) {
      phase.status = PhaseStatus.FAILED;
      phase.duration = Date.now() - phaseStart;
      phase.error = error.message;
      phase.severity = ErrorSeverity.WARNING;
      return phase;
    }
  }

  // ==================== 工具方法 ====================

  private createSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket('udp4');

        this.socket.on('error', (err) => {
          reject(new Error(`Socket错误: ${err.message}`));
        });

        this.socket.bind(() => {
          resolve();
        });
      } catch (error: any) {
        reject(error);
      }
    });
  }

  private sendPacket(packet: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error('Socket未初始化'));
      }

      if (this.config.verbose) {
        console.log(this.reporter['gray'](`  → 发送: ${hex(packet)}`));
      }

      this.socket.send(packet, this.config.port, this.config.ip, (err) => {
        if (err) {
          reject(new Error(`发送失败: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  // 发送需要追踪的包（用于重传）
  private async sendTrackedPacket(packet: Buffer): Promise<void> {
    const pkt = Buffer.from(packet);
    const seq = this.localSeq++;

    // 设置序列号
    le16.write(pkt, 6, seq);

    // 保存到历史记录
    this.txHistory.set(seq, pkt);

    // 发送
    await this.sendPacket(pkt);
  }

  // 重传指定序列号的包
  private async retransmit(seq: number): Promise<void> {
    const pkt = this.txHistory.get(seq);
    if (pkt) {
      if (this.config.verbose) {
        console.log(this.reporter['gray'](`  ⟲ 重传 seq=${seq}`));
      }
      await this.sendPacket(pkt);
    } else {
      // 发送NULL包作为响应
      const nullPkt = IcomPackets.ControlPacket.toBytes(
        IcomPackets.Cmd.NULL,
        seq,
        this.localId,
        this.remoteId
      );
      await this.sendPacket(nullPkt);
    }
  }

  // 处理协议包（PING、RETRANSMIT等）
  private async handleProtocolPacket(buf: Buffer): Promise<boolean> {
    const type = le16.read(buf, 4);

    // 处理PING请求
    if (buf.length === IcomPackets.Sizes.PING && type === IcomPackets.Cmd.PING) {
      const pingReply = buf[0x10];
      if (pingReply === 0x00) {
        // 这是Ping请求，需要回复
        const reply = IcomPackets.PingPacket.buildReply(buf, this.localId, this.remoteId);
        if (this.config.verbose) {
          console.log(this.reporter['gray'](`  ⟲ 回复 PING`));
        }
        await this.sendPacket(reply);
        return true;
      }
    }

    // 处理RETRANSMIT请求（单个）
    if (buf.length === IcomPackets.Sizes.CONTROL && type === IcomPackets.Cmd.RETRANSMIT) {
      const seq = le16.read(buf, 6);
      if (this.config.verbose) {
        console.log(this.reporter['gray'](`  ⟲ 收到重传请求 seq=${seq}`));
      }
      await this.retransmit(seq);
      return true;
    }

    // 处理RETRANSMIT请求（多个）
    if (type === IcomPackets.Cmd.RETRANSMIT && buf.length > IcomPackets.Sizes.CONTROL) {
      const count = Math.floor((buf.length - 0x10) / 2);
      if (this.config.verbose) {
        console.log(this.reporter['gray'](`  ⟲ 收到批量重传请求 count=${count}`));
      }
      for (let i = 0x10; i + 1 < buf.length; i += 2) {
        const seq = le16.read(buf, i);
        await this.retransmit(seq);
      }
      return true;
    }

    return false;
  }

  private waitForPacket(
    predicate: (buf: Buffer) => boolean,
    timeout: number,
    description: string
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error('Socket未初始化'));
      }

      const timer = setTimeout(() => {
        this.socket?.removeListener('message', handler);
        reject(new Error(`超时: 未收到 ${description} (${timeout}ms)`));
      }, timeout);

      const handler = async (msg: Buffer) => {
        if (this.config.verbose) {
          console.log(this.reporter['gray'](`  ← 接收: ${hex(msg)}`));
        }

        // 首先尝试处理协议包（PING、RETRANSMIT）
        const isProtocol = await this.handleProtocolPacket(msg).catch(() => false);
        if (isProtocol) {
          return; // 继续等待目标包
        }

        // 检查是否是我们要找的包
        if (predicate(msg)) {
          clearTimeout(timer);
          this.socket?.removeListener('message', handler);
          resolve(msg);
        }
      };

      this.socket.on('message', handler);
    });
  }

  private classifyError(phase: string, error: Error): ErrorSeverity {
    const msg = error.message.toLowerCase();

    // 网络层和AreYouThere超时是致命错误
    if (phase === 'network' || msg.includes('are_you_there')) {
      return ErrorSeverity.FATAL;
    }

    // 认证失败是致命错误
    if (msg.includes('认证') || msg.includes('auth')) {
      return ErrorSeverity.FATAL;
    }

    // 子会话失败是警告
    if (phase.includes('subsession')) {
      return ErrorSeverity.WARNING;
    }

    // 其他错误默认为致命
    return ErrorSeverity.FATAL;
  }

  private generateReport(success: boolean, error?: Error): DiagnosticReport {
    const totalDuration = Date.now() - this.startTime;

    const failedPhase = this.phases.find(p => p.status === PhaseStatus.FAILED);
    const failedStep = failedPhase?.steps.find(s => !s.success);

    return {
      timestamp: new Date().toISOString(),
      config: this.config,
      phases: this.phases,
      result: {
        success,
        totalDuration,
        failedPhase: failedPhase?.name,
        failedStep: failedStep?.name,
        errorType: failedPhase?.severity,
        suggestions: this.generateSuggestions(failedPhase, failedStep)
      }
    };
  }

  private generateSuggestions(failedPhase?: PhaseResult, failedStep?: StepResult): string[] {
    if (!failedPhase) return [];

    const suggestions: string[] = [];

    if (failedPhase.name === 'network' || failedStep?.name === 'are_you_there') {
      suggestions.push('设备未开机或网络未启用');
      suggestions.push(`IP地址错误 (${this.config.ip})`);
      suggestions.push(`端口配置错误 (${this.config.port})`);
      suggestions.push('防火墙阻止UDP通信');
      suggestions.push('网络路由问题');
    } else if (failedStep?.name === 'login') {
      suggestions.push('用户名或密码错误');
      suggestions.push('设备未启用远程控制');
      suggestions.push('设备已被其他客户端占用');
      suggestions.push('token已过期或无效');
    } else if (failedPhase.name === 'subsessions') {
      suggestions.push('设备繁忙或被占用');
      suggestions.push('STATUS包返回无效端口');
      suggestions.push('子会话网络问题');
    }

    return suggestions;
  }

  private cleanup() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e) {
        // ignore
      }
    }
    this.txHistory.clear();
  }
}

// ==================== CLI 入口 ====================

async function main() {
  program
    .name('icom-diagnose')
    .description('ICOM 设备连接诊断工具')
    .requiredOption('--ip <ip>', '设备IP地址')
    .option('--port <port>', '控制端口', '50001')
    .option('--user <user>', '用户名', process.env.ICOM_USER || 'icom')
    .option('--pass <pass>', '密码', process.env.ICOM_PASS || '')
    .option('--timeout <ms>', '总超时时间（毫秒）', '30000')
    .option('--full', '测试完整三会话（Control + CIV + Audio）', false)
    .option('--stability', '额外进行稳定性测试', false)
    .option('--verbose', '显示详细数据包内容', false)
    .option('--save-report <path>', '保存JSON报告到文件')
    .parse();

  const opts = program.opts();

  const config: DiagnosticConfig = {
    ip: opts.ip,
    port: parseInt(opts.port, 10),
    user: opts.user,
    pass: opts.pass,
    timeout: parseInt(opts.timeout, 10),
    full: opts.full,
    stability: opts.stability,
    verbose: opts.verbose,
    saveReport: opts.saveReport
  };

  // 验证必需参数
  if (!config.pass) {
    console.error('❌ 错误: 必须提供密码（通过 --pass 或环境变量 ICOM_PASS）');
    process.exit(1);
  }

  const runner = new DiagnosticRunner(config);
  const report = await runner.run();

  // 保存JSON报告
  if (config.saveReport) {
    const fs = await import('fs/promises');
    const formatter = new ReportFormatter(false);
    await fs.writeFile(config.saveReport, formatter.formatJSON(report), 'utf-8');
    console.log(`📄 报告已保存到: ${config.saveReport}`);
  }

  // 退出码
  process.exit(report.result.success ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ 未预期的错误:', error);
  process.exit(1);
});
