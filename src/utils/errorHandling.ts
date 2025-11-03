/**
 * 全局错误处理工具函数
 *
 * 这个模块提供可选的全局错误处理器，帮助用户防止未捕获的 Promise rejection 和异常导致进程崩溃。
 *
 * 使用方式：
 * ```typescript
 * import { setupGlobalErrorHandlers } from 'icom-wlan-node/utils/errorHandling';
 *
 * // 在应用启动时调用（可选）
 * setupGlobalErrorHandlers({
 *   onUnhandledRejection: (reason, promise) => {
 *     console.error('未处理的 Promise rejection:', reason);
 *     // 自定义处理逻辑
 *   },
 *   onUncaughtException: (error, origin) => {
 *     console.error('未捕获的异常:', error);
 *     // 自定义处理逻辑
 *   }
 * });
 * ```
 */

export interface GlobalErrorHandlerOptions {
  /**
   * 处理未捕获的 Promise rejection
   * @param reason - rejection 的原因
   * @param promise - 被 reject 的 Promise
   */
  onUnhandledRejection?: (reason: any, promise: Promise<any>) => void;

  /**
   * 处理未捕获的异常
   * @param error - 异常对象
   * @param origin - 异常来源 ('uncaughtException' 或 'unhandledRejection')
   */
  onUncaughtException?: (error: Error, origin: string) => void;

  /**
   * 是否在处理错误后阻止进程退出（默认 true）
   * 设为 false 时，错误会被记录但进程仍可能退出
   */
  preventExit?: boolean;
}

/**
 * 设置全局错误处理器
 *
 * 注意：这是一个可选的工具函数，仅在需要时使用。
 * 如果你的应用已经有全局错误处理逻辑，不需要调用此函数。
 *
 * @param options - 错误处理选项
 * @returns cleanup 函数，用于移除错误处理器
 */
export function setupGlobalErrorHandlers(options: GlobalErrorHandlerOptions = {}): () => void {
  const {
    onUnhandledRejection = defaultUnhandledRejectionHandler,
    onUncaughtException = defaultUncaughtExceptionHandler,
    preventExit = true
  } = options;

  // 未处理的 Promise rejection 处理器
  const unhandledRejectionHandler = (reason: any, promise: Promise<any>) => {
    console.error('⚠️  [icom-wlan-node] 检测到未处理的 Promise rejection:');
    console.error('原因:', reason);
    console.error('Promise:', promise);

    if (reason instanceof Error) {
      console.error('错误堆栈:', reason.stack);
    }

    // 调用用户自定义处理器
    onUnhandledRejection(reason, promise);
  };

  // 未捕获的异常处理器
  const uncaughtExceptionHandler = (error: Error, origin: string) => {
    console.error('⚠️  [icom-wlan-node] 检测到未捕获的异常:');
    console.error('错误:', error);
    console.error('来源:', origin);
    console.error('堆栈:', error.stack);

    // 调用用户自定义处理器
    onUncaughtException(error, origin);

    // 根据配置决定是否退出
    if (!preventExit) {
      console.error('进程即将退出...');
      process.exit(1);
    }
  };

  // 注册处理器
  process.on('unhandledRejection', unhandledRejectionHandler);
  process.on('uncaughtException', uncaughtExceptionHandler);

  console.log('✓ [icom-wlan-node] 全局错误处理器已设置');

  // 返回 cleanup 函数
  return () => {
    process.off('unhandledRejection', unhandledRejectionHandler);
    process.off('uncaughtException', uncaughtExceptionHandler);
    console.log('✓ [icom-wlan-node] 全局错误处理器已移除');
  };
}

/**
 * 默认的未处理 Promise rejection 处理器
 */
function defaultUnhandledRejectionHandler(reason: any, promise: Promise<any>): void {
  // 检查是否是网络错误（可以优雅处理）
  if (isNetworkError(reason)) {
    console.warn('网络错误已被捕获，但未影响进程稳定性');
    return;
  }

  // 其他错误记录为警告
  console.warn('检测到未处理的 Promise rejection，但进程继续运行');
}

/**
 * 默认的未捕获异常处理器
 */
function defaultUncaughtExceptionHandler(error: Error, origin: string): void {
  // 检查是否是可恢复的错误
  if (isRecoverableError(error)) {
    console.warn('可恢复的错误已被捕获，进程继续运行');
    return;
  }

  console.error('检测到严重错误，建议检查应用逻辑');
}

/**
 * 判断是否是网络错误
 */
function isNetworkError(error: any): boolean {
  if (!error) return false;

  const networkErrorCodes = [
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND'
  ];

  // 检查错误码
  if (error.code && networkErrorCodes.includes(error.code)) {
    return true;
  }

  // 检查错误消息
  if (error.message && typeof error.message === 'string') {
    return networkErrorCodes.some(code => error.message.includes(code));
  }

  return false;
}

/**
 * 判断是否是可恢复的错误
 */
function isRecoverableError(error: Error): boolean {
  // 网络错误通常是可恢复的
  if (isNetworkError(error)) {
    return true;
  }

  // 连接相关的错误也是可恢复的
  const recoverableMessages = [
    'Connection failed',
    'User disconnect',
    'Connection timeout',
    'CIV/Audio sessions timeout'
  ];

  return recoverableMessages.some(msg => error.message.includes(msg));
}

/**
 * 快速设置：仅防止进程崩溃，使用默认错误处理
 */
export function setupBasicErrorProtection(): () => void {
  return setupGlobalErrorHandlers({
    preventExit: true
  });
}
