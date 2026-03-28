#!/usr/bin/env tsx
/**
 * ICOM 重连策略测试工具
 * 用于测试异常断开后的各种重连方案,找到最优策略
 */

import { program } from 'commander';
import { IcomControl } from '../src/rig/IcomControl';
import { DisconnectReason } from '../src/types';
import * as IcomPackets from '../src/core/IcomPackets';
import dgram from 'dgram';

// ==================== 类型定义 ====================

/**
 * 断开场景类型
 */
enum DisconnectScenario {
  NORMAL = 'normal',           // 正常调用disconnect()
  TIMEOUT = 'timeout',         // 模拟超时(不发送DISCONNECT包)
  FORCE_KILL = 'force_kill',   // 模拟程序崩溃(直接关闭socket)
  RADIO_STALE = 'radio_stale'  // 电台侧认为连接着(客户端已断开但电台未收到DISCONNECT)
}

/**
 * 重连策略类型
 */
enum ReconnectStrategy {
  FULL_RESET = 'full_reset',           // 策略A: 完全重置重连(当前默认)
  FORCE_DISCONNECT = 'force_disconnect', // 策略B: 强制断开+重连
  PRESERVE_STATE = 'preserve_state',    // 策略C: 保留状态重连
  SMART_PROBE = 'smart_probe',         // 策略D: 智能探测重连
  PROGRESSIVE = 'progressive'          // 策略E: 渐进式重连
}

/**
 * 测试配置
 */
interface TestConfig {
  ip: string;
  port: number;
  user: string;
  pass: string;
  scenario: DisconnectScenario;
  strategy: ReconnectStrategy;
  waitBeforeReconnect: number;  // 断开后等待多久再重连(ms)
  rounds: number;                // 测试轮数
  verbose: boolean;
  saveReport?: string;
}

/**
 * 单次测试结果
 */
interface TestResult {
  round: number;
  scenario: DisconnectScenario;
  strategy: ReconnectStrategy;
  success: boolean;
  connectDuration: number;       // 首次连接耗时
  disconnectDuration: number;    // 断开耗时
  reconnectDuration: number;     // 重连耗时
  error?: string;
  details?: any;
}

/**
 * 测试报告
 */
interface TestReport {
  timestamp: string;
  config: TestConfig;
  results: TestResult[];
  summary: {
    totalTests: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgConnectTime: number;
    avgReconnectTime: number;
    recommendations: string[];
  };
}

// ==================== 会话状态保存 ====================

/**
 * 保存的会话状态(用于策略C)
 */
interface SavedSessionState {
  // Control session
  controlLocalId: number;
  controlRemoteId: number;
  controlTrackedSeq: number;
  controlInnerSeq: number;
  controlRigToken: number;
  controlLocalToken: number;

  // CIV session
  civLocalId: number;
  civRemoteId: number;
  civTrackedSeq: number;

  // Audio session
  audioLocalId: number;
  audioRemoteId: number;
  audioTrackedSeq: number;

  // Other state
  civPort: number;
  audioPort: number;
}

// ==================== 颜色输出工具 ====================

class ColorOutput {
  constructor(private useColor = true) {}

  private color(text: string, code: number): string {
    return this.useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  green(text: string) { return this.color(text, 32); }
  red(text: string) { return this.color(text, 31); }
  yellow(text: string) { return this.color(text, 33); }
  cyan(text: string) { return this.color(text, 36); }
  gray(text: string) { return this.color(text, 90); }
  bold(text: string) { return this.color(text, 1); }
}

// ==================== 核心测试逻辑 ====================

class ReconnectTester {
  private config: TestConfig;
  private out: ColorOutput;
  private results: TestResult[] = [];
  private savedState?: SavedSessionState;

  constructor(config: TestConfig) {
    this.config = config;
    this.out = new ColorOutput(!config.saveReport);
  }

  /**
   * 运行所有测试轮次
   */
  async run(): Promise<TestReport> {
    this.printHeader();

    for (let round = 1; round <= this.config.rounds; round++) {
      console.log(this.out.cyan(`\n━━━━━━ 第 ${round}/${this.config.rounds} 轮 ━━━━━━\n`));

      const result = await this.runSingleTest(round);
      this.results.push(result);

      this.printRoundResult(result);

      // 如果测试失败且不是最后一轮,询问是否继续
      if (!result.success && round < this.config.rounds) {
        console.log(this.out.yellow('\n⚠️  测试失败,等待5秒后继续下一轮...\n'));
        await this.sleep(5000);
      }

      // 轮次间等待
      if (round < this.config.rounds) {
        await this.sleep(2000);
      }
    }

    const report = this.generateReport();
    this.printSummary(report);

    return report;
  }

  /**
   * 运行单次测试
   */
  private async runSingleTest(round: number): Promise<TestResult> {
    const result: TestResult = {
      round,
      scenario: this.config.scenario,
      strategy: this.config.strategy,
      success: false,
      connectDuration: 0,
      disconnectDuration: 0,
      reconnectDuration: 0
    };

    let rig: IcomControl | undefined;

    try {
      // 步骤1: 初始连接
      console.log(this.out.gray('  [1/4] 初始连接...'));
      const connectStart = Date.now();

      rig = new IcomControl({
        control: {
          ip: this.config.ip,
          port: this.config.port
        },
        login: {
          user: this.config.user,
          password: this.config.pass
        }
      });

      await rig.connect();
      result.connectDuration = Date.now() - connectStart;
      console.log(this.out.green(`  ✓ 连接成功 (${result.connectDuration}ms)`));

      // 等待一小段时间确保连接稳定
      await this.sleep(1000);

      // 步骤2: 执行断开场景
      console.log(this.out.gray(`  [2/4] 执行断开场景: ${this.config.scenario}...`));
      const disconnectStart = Date.now();

      await this.executeDisconnectScenario(rig);

      result.disconnectDuration = Date.now() - disconnectStart;
      console.log(this.out.green(`  ✓ 断开完成 (${result.disconnectDuration}ms)`));

      // 步骤3: 等待后重连
      console.log(this.out.gray(`  [3/4] 等待 ${this.config.waitBeforeReconnect}ms 后重连...`));
      await this.sleep(this.config.waitBeforeReconnect);

      // 步骤4: 执行重连策略
      console.log(this.out.gray(`  [4/4] 执行重连策略: ${this.config.strategy}...`));
      const reconnectStart = Date.now();

      await this.executeReconnectStrategy(rig);

      result.reconnectDuration = Date.now() - reconnectStart;
      console.log(this.out.green(`  ✓ 重连成功 (${result.reconnectDuration}ms)`));

      result.success = true;

      // 清理: 正常断开
      await rig.disconnect();

    } catch (error: any) {
      result.success = false;
      result.error = error.message;
      console.log(this.out.red(`  ✗ 测试失败: ${error.message}`));

      if (this.config.verbose && error.stack) {
        console.log(this.out.gray(error.stack));
      }
    } finally {
      // 确保清理
      if (rig) {
        try {
          await rig.disconnect({ reason: DisconnectReason.CLEANUP, silent: true });
        } catch (e) {
          // ignore
        }
      }
    }

    return result;
  }

  /**
   * 执行断开场景
   */
  private async executeDisconnectScenario(rig: IcomControl): Promise<void> {
    // 在所有非正常断开场景中,先保存状态
    // 这样策略B和D可以使用保存的ID发送DISCONNECT或进行探测
    if (this.config.scenario !== DisconnectScenario.NORMAL) {
      this.savedState = this.saveSessionState(rig);
    }

    switch (this.config.scenario) {
      case DisconnectScenario.NORMAL:
        // 正常断开
        await rig.disconnect();
        break;

      case DisconnectScenario.TIMEOUT:
        // 模拟超时:不发送DISCONNECT包,直接关闭socket
        // 通过访问内部session来强制关闭
        (rig as any).sess?.close();
        (rig as any).civSess?.close();
        (rig as any).audioSess?.close();
        break;

      case DisconnectScenario.FORCE_KILL:
        // 模拟程序崩溃:直接关闭所有资源,不做任何清理
        (rig as any).sess?.socket?.close();
        (rig as any).civSess?.socket?.close();
        (rig as any).audioSess?.socket?.close();
        break;

      case DisconnectScenario.RADIO_STALE:
        // 模拟电台侧仍认为连接着的情况
        // 不发送DISCONNECT,直接关闭
        (rig as any).sess?.close();
        (rig as any).civSess?.close();
        (rig as any).audioSess?.close();
        break;
    }
  }

  /**
   * 执行重连策略
   */
  private async executeReconnectStrategy(rig: IcomControl): Promise<void> {
    switch (this.config.strategy) {
      case ReconnectStrategy.FULL_RESET:
        // 策略A: 完全重置重连(当前默认行为)
        await rig.connect();
        break;

      case ReconnectStrategy.FORCE_DISCONNECT:
        // 策略B: 先强制发送DISCONNECT包,再重连
        await this.forceDisconnectBeforeReconnect(rig);
        await rig.connect();
        break;

      case ReconnectStrategy.PRESERVE_STATE:
        // 策略C: 保留状态重连
        if (this.savedState) {
          await this.reconnectWithPreservedState(rig, this.savedState);
        } else {
          throw new Error('策略C需要保存的状态,但状态为空');
        }
        break;

      case ReconnectStrategy.SMART_PROBE:
        // 策略D: 智能探测
        await this.smartProbeReconnect(rig);
        break;

      case ReconnectStrategy.PROGRESSIVE:
        // 策略E: 渐进式重连
        await this.progressiveReconnect(rig);
        break;
    }
  }

  /**
   * 保存会话状态
   */
  private saveSessionState(rig: IcomControl): SavedSessionState {
    const sess = (rig as any).sess;
    const civSess = (rig as any).civSess;
    const audioSess = (rig as any).audioSess;

    return {
      controlLocalId: sess.localId,
      controlRemoteId: sess.remoteId,
      controlTrackedSeq: sess.trackedSeq,
      controlInnerSeq: sess.innerSeq,
      controlRigToken: sess.rigToken,
      controlLocalToken: sess.localToken,

      civLocalId: civSess.localId,
      civRemoteId: civSess.remoteId,
      civTrackedSeq: civSess.trackedSeq,

      audioLocalId: audioSess.localId,
      audioRemoteId: audioSess.remoteId,
      audioTrackedSeq: audioSess.trackedSeq,

      civPort: civSess.address.port,
      audioPort: audioSess.address.port
    };
  }

  /**
   * 策略B: 强制断开后重连
   */
  private async forceDisconnectBeforeReconnect(rig: IcomControl): Promise<void> {
    console.log(this.out.yellow('    [策略B] 强制发送DISCONNECT包...'));

    // 重新打开socket
    const sess = (rig as any).sess;
    const civSess = (rig as any).civSess;
    const audioSess = (rig as any).audioSess;

    sess?.open();
    civSess?.open();
    audioSess?.open();

    // 发送DISCONNECT包到电台
    // 使用保存的ID(如果有)
    if (this.savedState) {
      console.log(this.out.gray(`    使用保存的ID发送DISCONNECT...`));

      try {
        // 发送DELETE token包
        const delToken = IcomPackets.TokenPacket.build(
          0,
          this.savedState.controlLocalId,
          this.savedState.controlRemoteId,
          IcomPackets.TokenType.DELETE,
          this.savedState.controlInnerSeq,
          this.savedState.controlLocalToken,
          this.savedState.controlRigToken
        );
        sess?.sendUntracked(delToken);

        // 发送DISCONNECT控制包
        const disconnectControl = IcomPackets.ControlPacket.toBytes(
          IcomPackets.Cmd.DISCONNECT,
          0,
          this.savedState.controlLocalId,
          this.savedState.controlRemoteId
        );
        sess?.sendUntracked(disconnectControl);

        // 也给子会话发送DISCONNECT
        const disconnectCiv = IcomPackets.ControlPacket.toBytes(
          IcomPackets.Cmd.DISCONNECT,
          0,
          this.savedState.civLocalId,
          this.savedState.civRemoteId
        );
        civSess?.sendUntracked(disconnectCiv);

        const disconnectAudio = IcomPackets.ControlPacket.toBytes(
          IcomPackets.Cmd.DISCONNECT,
          0,
          this.savedState.audioLocalId,
          this.savedState.audioRemoteId
        );
        audioSess?.sendUntracked(disconnectAudio);

        console.log(this.out.gray('    DISCONNECT包已发送'));
      } catch (error: any) {
        console.log(this.out.yellow(`    发送DISCONNECT包失败: ${error.message}`));
      }
    }

    // 等待电台处理DISCONNECT
    await this.sleep(1000);
  }

  /**
   * 策略C: 保留状态重连
   */
  private async reconnectWithPreservedState(
    rig: IcomControl,
    state: SavedSessionState
  ): Promise<void> {
    console.log(this.out.yellow('    [策略C] 恢复保存的会话状态...'));

    const sess = (rig as any).sess;
    const civSess = (rig as any).civSess;
    const audioSess = (rig as any).audioSess;

    // 恢复状态(不调用resetState)
    sess.localId = state.controlLocalId;
    sess.remoteId = state.controlRemoteId;
    sess.trackedSeq = state.controlTrackedSeq;
    sess.innerSeq = state.controlInnerSeq;
    sess.rigToken = state.controlRigToken;
    sess.localToken = state.controlLocalToken;

    civSess.localId = state.civLocalId;
    civSess.remoteId = state.civRemoteId;
    civSess.trackedSeq = state.civTrackedSeq;
    civSess.address.port = state.civPort;

    audioSess.localId = state.audioLocalId;
    audioSess.remoteId = state.audioRemoteId;
    audioSess.trackedSeq = state.audioTrackedSeq;
    audioSess.address.port = state.audioPort;

    // 重新打开socket
    sess.open();
    civSess.open();
    audioSess.open();

    // 尝试发送ping测试连接
    console.log(this.out.gray('    发送ping测试连接...'));

    try {
      // 发送ping包
      const pingPacket = IcomPackets.PingPacket.buildPing(
        state.controlLocalId,
        state.controlRemoteId,
        state.controlTrackedSeq
      );

      await this.sendAndWaitForPingReply(sess, pingPacket, 3000);

      console.log(this.out.green('    ✓ Ping成功,会话恢复'));

      // 重新启动心跳和监控
      // 注意: 这里可能需要手动启动一些定时器
      // 但为了简化测试,我们假设会话已经恢复

    } catch (error: any) {
      console.log(this.out.red(`    ✗ Ping失败: ${error.message}`));
      throw new Error(`保留状态重连失败: ${error.message}`);
    }
  }

  /**
   * 发送ping并等待回复
   */
  private async sendAndWaitForPingReply(
    sess: any,
    pingPacket: Buffer,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sess.socket?.removeListener('message', handler);
        reject(new Error(`Ping超时 (${timeout}ms)`));
      }, timeout);

      const handler = (msg: Buffer) => {
        if (IcomPackets.PingPacket.isPing(msg) && IcomPackets.PingPacket.getReply(msg) === 1) {
          clearTimeout(timer);
          sess.socket?.removeListener('message', handler);
          resolve();
        }
      };

      sess.socket?.on('message', handler);
      sess.sendUntracked(pingPacket);
    });
  }

  /**
   * 策略D: 智能探测重连
   */
  private async smartProbeReconnect(rig: IcomControl): Promise<void> {
    console.log(this.out.yellow('    [策略D] 智能探测电台状态...'));

    if (this.savedState) {
      console.log(this.out.gray('    尝试使用保存状态ping电台...'));

      const sess = (rig as any).sess;
      let probeSuccess = false;

      try {
        // 临时恢复状态用于探测
        const oldLocalId = sess.localId;
        const oldRemoteId = sess.remoteId;

        sess.localId = this.savedState.controlLocalId;
        sess.remoteId = this.savedState.controlRemoteId;
        sess.open();

        // 发送ping
        const pingPacket = IcomPackets.PingPacket.buildPing(
          this.savedState.controlLocalId,
          this.savedState.controlRemoteId,
          this.savedState.controlTrackedSeq
        );

        await this.sendAndWaitForPingReply(sess, pingPacket, 2000);

        probeSuccess = true;
        console.log(this.out.green('    ✓ 探测成功,电台仍认为连接着'));

      } catch (error: any) {
        probeSuccess = false;
        console.log(this.out.yellow(`    探测失败: ${error.message}`));
      }

      if (probeSuccess) {
        console.log(this.out.cyan('    → 使用策略C(保留状态重连)'));
        await this.reconnectWithPreservedState(rig, this.savedState);
      } else {
        console.log(this.out.cyan('    → 使用策略A(完全重置重连)'));
        await rig.connect();
      }
    } else {
      console.log(this.out.yellow('    无保存状态,使用完全重置重连'));
      await rig.connect();
    }
  }

  /**
   * 策略E: 渐进式重连
   */
  private async progressiveReconnect(rig: IcomControl): Promise<void> {
    console.log(this.out.yellow('    [策略E] 渐进式重连(跳过AreYouThere)...'));

    // TODO: 实现渐进式重连逻辑
    // 跳过AreYouThere/AreYouReady,直接从Login开始

    // 暂时回退到默认策略
    await rig.connect();
  }

  /**
   * 生成测试报告
   */
  private generateReport(): TestReport {
    const successResults = this.results.filter(r => r.success);
    const failureResults = this.results.filter(r => !r.success);

    const avgConnectTime = successResults.length > 0
      ? successResults.reduce((sum, r) => sum + r.connectDuration, 0) / successResults.length
      : 0;

    const avgReconnectTime = successResults.length > 0
      ? successResults.reduce((sum, r) => sum + r.reconnectDuration, 0) / successResults.length
      : 0;

    return {
      timestamp: new Date().toISOString(),
      config: this.config,
      results: this.results,
      summary: {
        totalTests: this.results.length,
        successCount: successResults.length,
        failureCount: failureResults.length,
        successRate: this.results.length > 0
          ? (successResults.length / this.results.length) * 100
          : 0,
        avgConnectTime,
        avgReconnectTime,
        recommendations: this.generateRecommendations()
      }
    };
  }

  /**
   * 生成建议
   */
  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const successRate = this.results.filter(r => r.success).length / this.results.length;

    if (successRate === 1.0) {
      recommendations.push(`策略${this.config.strategy}在场景${this.config.scenario}下100%成功`);
      recommendations.push('可以作为该场景的推荐策略');
    } else if (successRate >= 0.8) {
      recommendations.push(`策略${this.config.strategy}成功率${(successRate * 100).toFixed(1)}%,较为可靠`);
      recommendations.push('建议增加测试轮数以验证稳定性');
    } else if (successRate >= 0.5) {
      recommendations.push(`策略${this.config.strategy}成功率${(successRate * 100).toFixed(1)}%,不够稳定`);
      recommendations.push('建议尝试其他策略');
    } else {
      recommendations.push(`策略${this.config.strategy}在场景${this.config.scenario}下不适用`);
      recommendations.push('建议使用其他策略');
    }

    return recommendations;
  }

  /**
   * 打印测试头部
   */
  private printHeader() {
    console.log('\n' + this.out.cyan('🔬 ICOM 重连策略测试'));
    console.log(this.out.gray('━'.repeat(60)));
    console.log(`设备: ${this.out.bold(this.config.ip + ':' + this.config.port)}`);
    console.log(`断开场景: ${this.out.bold(this.config.scenario)}`);
    console.log(`重连策略: ${this.out.bold(this.config.strategy)}`);
    console.log(`测试轮数: ${this.out.bold(this.config.rounds.toString())}`);
    console.log('');
  }

  /**
   * 打印单轮结果
   */
  private printRoundResult(result: TestResult) {
    const status = result.success
      ? this.out.green(`✓ 成功`)
      : this.out.red(`✗ 失败`);

    console.log(`  ${status} - 连接:${result.connectDuration}ms, 重连:${result.reconnectDuration}ms`);

    if (!result.success && result.error) {
      console.log(this.out.red(`    错误: ${result.error}`));
    }
  }

  /**
   * 打印测试摘要
   */
  private printSummary(report: TestReport) {
    console.log('\n' + this.out.gray('━'.repeat(60)));
    console.log(this.out.cyan('📊 测试摘要\n'));

    const successRate = report.summary.successRate;
    const successRateColor = successRate === 100
      ? this.out.green
      : successRate >= 80
        ? this.out.yellow
        : this.out.red;

    console.log(`总测试数: ${report.summary.totalTests}`);
    console.log(`成功: ${this.out.green(report.summary.successCount.toString())}`);
    console.log(`失败: ${this.out.red(report.summary.failureCount.toString())}`);
    console.log(`成功率: ${successRateColor(successRate.toFixed(1) + '%')}`);
    console.log(`平均连接时间: ${report.summary.avgConnectTime.toFixed(0)}ms`);
    console.log(`平均重连时间: ${report.summary.avgReconnectTime.toFixed(0)}ms`);

    if (report.summary.recommendations.length > 0) {
      console.log('\n' + this.out.cyan('💡 建议:'));
      report.summary.recommendations.forEach(r => {
        console.log(`  • ${r}`);
      });
    }

    console.log('');
  }

  /**
   * 睡眠工具
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ==================== CLI 入口 ====================

async function main() {
  program
    .name('test-reconnect-strategies')
    .description('ICOM 重连策略测试工具')
    .requiredOption('--ip <ip>', '设备IP地址')
    .option('--port <port>', '控制端口', '50001')
    .option('--user <user>', '用户名', process.env.ICOM_USER || 'icom')
    .option('--pass <pass>', '密码', process.env.ICOM_PASS || '')
    .option(
      '--scenario <scenario>',
      '断开场景: normal, timeout, force_kill, radio_stale',
      'timeout'
    )
    .option(
      '--strategy <strategy>',
      '重连策略: full_reset, force_disconnect, preserve_state, smart_probe, progressive',
      'full_reset'
    )
    .option('--wait <ms>', '断开后等待时间(ms)', '2000')
    .option('--rounds <n>', '测试轮数', '3')
    .option('--verbose', '详细输出', false)
    .option('--save-report <path>', '保存JSON报告到文件')
    .parse();

  const opts = program.opts();

  // 验证必需参数
  if (!opts.pass) {
    console.error('❌ 错误: 必须提供密码(通过 --pass 或环境变量 ICOM_PASS)');
    process.exit(1);
  }

  // 验证枚举值
  if (!Object.values(DisconnectScenario).includes(opts.scenario)) {
    console.error(`❌ 错误: 无效的断开场景 "${opts.scenario}"`);
    console.error(`支持的场景: ${Object.values(DisconnectScenario).join(', ')}`);
    process.exit(1);
  }

  if (!Object.values(ReconnectStrategy).includes(opts.strategy)) {
    console.error(`❌ 错误: 无效的重连策略 "${opts.strategy}"`);
    console.error(`支持的策略: ${Object.values(ReconnectStrategy).join(', ')}`);
    process.exit(1);
  }

  const config: TestConfig = {
    ip: opts.ip,
    port: parseInt(opts.port, 10),
    user: opts.user,
    pass: opts.pass,
    scenario: opts.scenario as DisconnectScenario,
    strategy: opts.strategy as ReconnectStrategy,
    waitBeforeReconnect: parseInt(opts.wait, 10),
    rounds: parseInt(opts.rounds, 10),
    verbose: opts.verbose,
    saveReport: opts.saveReport
  };

  const tester = new ReconnectTester(config);
  const report = await tester.run();

  // 保存JSON报告
  if (config.saveReport) {
    const fs = await import('fs/promises');
    await fs.writeFile(
      config.saveReport,
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    console.log(`📄 报告已保存到: ${config.saveReport}`);
  }

  // 退出码
  const exitCode = report.summary.successRate === 100 ? 0 : 1;
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('❌ 未预期的错误:', error);
  process.exit(1);
});
