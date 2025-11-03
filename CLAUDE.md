# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

### 构建和开发
```bash
npm run build          # 编译 TypeScript 到 dist/
npm run clean          # 清理 dist/ 目录
npm run lint           # 运行 ESLint
```

### 测试
```bash
npm test                                    # 运行所有测试
npm test -- __tests__/packets.test.ts       # 运行特定测试文件
npm test -- --verbose                       # 详细输出

# 针对真实设备的集成测试（需要环境变量）
ICOM_IP=192.168.31.253 \
ICOM_PORT=50001 \
ICOM_USER=icom \
ICOM_PASS=icomicom \
npm test
```

## 核心架构

### 三层设计

1. **传输层** (`src/transport/`)
   - `UdpClient.ts` - 封装 Node.js dgram 套接字

2. **核心协议层** (`src/core/`)
   - `IcomPackets.ts` - 所有数据包的构建和解析（控制、登录、令牌、CIV、音频等）
   - `Session.ts` - UDP 会话管理，处理序列号、重传历史、心跳

3. **设备控制层** (`src/rig/`)
   - `IcomControl.ts` - **主入口类**，协调所有子会话，提供高级 API
   - `IcomCiv.ts` - CI-V 子会话处理
   - `IcomAudio.ts` - 音频收发处理
   - `IcomRigCommands.ts` - CI-V 命令构建器
   - `IcomConstants.ts` - 常数和模式映射

### 多会话架构（关键设计）

**IcomControl 协调三个独立的 UDP 会话**：

1. **Control 会话**（端口 50001，默认）
   - 处理初始握手（AreYouThere/AreYouReady）
   - 登录认证（0x80/0x60）
   - 令牌管理（0x40）
   - 获取连接信息（0x90/0x50）

2. **CIV 会话**（动态端口，从 Status 包获取）
   - CI-V 命令传输
   - 保持连接存活（OpenClose 心跳，500ms）

3. **Audio 会话**（动态端口，从 Status 包获取）
   - 音频流收发
   - LPCM 16 位单声道 @ 12 kHz
   - 20ms 帧（240 样本/帧）
   - 使用精确定时器避免漂移

**连接流程**：
```
connect() → AreYouThere → AreYouReady
          → Login(0x80) → LoginResponse(0x60)
          → ConnInfo(0x90) → Status(0x50，包含 CIV/Audio 端口)
          → 建立 CIV 和 Audio 子会话
```

### 事件驱动模型

所有数据接收通过 `IcomControl.events` 发出：
- `login` - 登录结果
- `status` - 状态信息（端口号等）
- `capabilities` - 设备能力（CIV 地址、音频名称）
- `civ` / `civFrame` - CI-V 数据
- `audio` - 音频帧
- `error` - UDP 错误

## 关键文件说明

### IcomControl.ts (~600 行)
**这是用户代码的主要入口点**。职责：
- 管理连接生命周期
- 协调三个 UDP 会话
- 分发事件给用户代码
- 提供高级 API（`setFrequency`, `setMode`, `setPtt`, `readOperatingFrequency` 等）

**修改时注意**：需要理解三个会话的交互时序。

### Session.ts (~200 行)
**UDP 会话的核心实现**。每个会话实例追踪：
- 本地/远程 ID 和序列号
- 发送历史（用于重传）
- 心跳和保活机制

**修改时注意**：序列号管理必须正确，否则设备会拒绝数据包。

### IcomPackets.ts (~420 行)
**定义所有数据包格式**。包含：
- 各种包的静态构建方法
- 字节序处理（混合使用 BE 和 LE）
- 预定义的包大小常数

**修改时注意**：必须使用 `codec.ts` 中的 `be16/be32/le16/le32` 函数。

### codec.ts (~60 行)
**字节序处理工具库**。提供：
- `be16/be32` - Big-Endian 读写
- `le16/le32` - Little-Endian 读写
- `intToBytesBE/LE` - 整数转字节数组
- `hex()` - Buffer 转十六进制字符串（调试用）

**强制使用规则**：所有数据包字段的读写必须通过这些函数，不得直接使用 `Buffer.readUInt16BE/LE()` 等方法。

---

## ⚠️ 重要：Java原始代码字节序命名陷阱

FT8CN项目中的Java代码（`IComPacketTypes.java`）存在**函数命名与实际实现相反**的问题！

### Java代码字节序函数对应表

| Java函数名 | 命名含义 | **实际实现** | 说明 |
|-----------|---------|------------|------|
| `intToBigEndian()` | 转Big-Endian | **Little-Endian** ❌ | 低字节在前 |
| `shortToBigEndian()` | 转Big-Endian | **Little-Endian** ❌ | 低字节在前 |
| `intToByte()` | 转字节数组 | **Big-Endian** ✓ | 高字节在前 |
| `shortToByte()` | 转字节数组 | **Big-Endian** ✓ | 高字节在前 |
| `readIntBigEndianData()` | 读Big-Endian | **Little-Endian** ❌ | 低字节在前 |
| `readShortBigEndianData()` | 读Big-Endian | **Little-Endian** ❌ | 低字节在前 |
| `readIntData()` | 读字节数据 | **Big-Endian** ✓ | 高字节在前 |
| `readShortData()` | 读字节数据 | **Big-Endian** ✓ | 高字节在前 |

### Java实现代码验证

```java
// intToBigEndian - 名字说Big-Endian，实际是Little-Endian
public static byte[] intToBigEndian(int n) {
    byte[] b = new byte[4];
    b[0] = (byte) (n & 0xff);           // 最低字节在前
    b[1] = (byte) (n >> 8 & 0xff);
    b[2] = (byte) (n >> 16 & 0xff);
    b[3] = (byte) (n >> 24 & 0xff);     // 最高字节在后
    return b;
}

// intToByte - 名字没说字节序，实际是Big-Endian
public static byte[] intToByte(int n) {
    byte[] b = new byte[4];
    b[3] = (byte) (n & 0xff);           // 最低字节在后
    b[2] = (byte) (n >> 8 & 0xff);
    b[1] = (byte) (n >> 16 & 0xff);
    b[0] = (byte) (n >> 24 & 0xff);     // 最高字节在前
    return b;
}
```

### TypeScript实现对应关系

⚠️ **重要更新（2025-01-20）**：TypeScript的`codec.ts`已修正为**正确的语义命名**！

现在的实现使用正确的命名（与Java的命名相反，但与实际字节序一致）：

```typescript
// 已修正：现在使用正确的语义命名（be=Big-Endian, le=Little-Endian）
export const be16 = {
  read: (buf: Buffer, off: number) => buf.readUInt16BE(off),  // Big-Endian: 高字节在前
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt16BE(v & 0xffff, off)
};

export const le16 = {
  read: (buf: Buffer, off: number) => buf.readUInt16LE(off),  // Little-Endian: 低字节在前
  write: (buf: Buffer, off: number, v: number) => buf.writeUInt16LE(v & 0xffff, off)
};
```

### 使用指南

在TypeScript代码中，根据Java函数的**实际字节序**（而非命名）来选择对应的TypeScript函数：

| Java函数 | Java命名含义 | Java实际字节序 | TypeScript函数 | 说明 |
|---------|-----------|------------|---------------|------|
| `shortToBigEndian()` | 转Big-Endian | **Little-Endian** | `le16.write()` | Java命名错误 |
| `readShortBigEndianData()` | 读Big-Endian | **Little-Endian** | `le16.read()` | Java命名错误 |
| `shortToByte()` | 转字节数组 | **Big-Endian** | `be16.write()` | Java命名正确 |
| `readShortData()` | 读字节数据 | **Big-Endian** | `be16.read()` | Java命名正确 |
| `intToBigEndian()` | 转Big-Endian | **Little-Endian** | `le32.write()` | Java命名错误 |
| `readIntBigEndianData()` | 读Big-Endian | **Little-Endian** | `le32.read()` | Java命名错误 |
| `intToByte()` | 转字节数组 | **Big-Endian** | `be32.write()` | Java命名正确 |
| `readIntData()` | 读字节数据 | **Big-Endian** | `be32.read()` | Java命名正确 |

## 关键数据包字段字节序参考

**注意**：以下使用的是修正后的TypeScript命名（be=Big-Endian, le=Little-Endian）

### 控制包头（所有包通用 0x00-0x0F）
- `0x00` len (4字节) - **LE** - 使用 `le32`
- `0x04` type (2字节) - **LE** - 使用 `le16`
- `0x06` seq (2字节) - **LE** - 使用 `le16`
- `0x08` sentId (4字节) - **LE** - 使用 `le32`
- `0x0C` rcvdId (4字节) - **LE** - 使用 `le32`

### Token/Login/ConnInfo包（0x40/0x80/0x90）
- `0x12` payloadSize (2字节) - **BE** - 使用 `be16`
- `0x16` innerSeq (2字节) - **BE** - 使用 `be16`
- `0x1A` tokRequest (2字节) - **BE** - 使用 `be16`
- `0x1C` token (4字节) - **BE** - 使用 `be32`

### CIV包（0xC1标识）
- `0x11` civ_len (2字节) - **LE** - 使用 `le16`
- `0x13` civSeq (2字节) - **BE** - 手动写入

### Audio包（0x97/0x00标识）
- `0x10` ident (2字节) - **BE** - 手动写入
- `0x12` sendSeq (2字节) - **BE** - 手动写入
- `0x16` datalen (2字节) - **BE** - 使用 `be16`

### Status包（0x50）
- `0x30` error (4字节) - **LE** - 使用 `le32.read()`
- `0x42` civPort (2字节) - **BE** - 使用 `be16.read()`
- `0x46` audioPort (2字节) - **BE** - 使用 `be16.read()`

## 常见错误

### ❌ 错误1：在IcomPackets.ts中使用错误的字节序函数
```typescript
// 错误：Audio包的datalen字段用了le16（LE）
le16.write(b, 0x16, audio.length);  // 与Java的shortToByte()（实际BE）不匹配
```

### ✓ 正确示例
```typescript
// 正确：Audio包的datalen字段应该用be16（BE）
be16.write(b, 0x16, audio.length);  // 匹配Java的shortToByte()（实际BE）
```

### ❌ 错误2：在IcomControl.ts中直接使用Buffer的readUInt方法

**重要警告**：不要在IcomControl.ts或其他地方直接使用`buf.readUInt16LE/BE()`或`buf.readUInt32LE/BE()`来读取数据包字段！

```typescript
// ❌ 错误：直接使用readUInt16LE读取Audio包的datalen
const len = buf.readUInt16LE(0x16);  // Audio datalen是BE，不是LE！

// ❌ 错误：即使用了正确的字节序，也容易出错
const len = buf.readUInt16BE(0x16);  // 应该使用codec.ts中的统一函数
```

### ✓ 推荐做法
```typescript
// ✓ 方法1：使用IcomPackets.ts中的辅助函数
if (AudioPacket.isAudioPacket(buf)) {
  const audio = AudioPacket.getAudioData(buf);
}

// ✓ 方法2：如果必须直接读取，导入并使用codec.ts中的函数
import { be16, be32, le16, le32 } from '../utils/codec';
const len = be16.read(buf, 0x16);  // 明确使用be16，与文档和ENDIAN_VERIFICATION.md一致
```

**历史bug记录（已修复）**：
- IcomControl.ts:321 曾错误使用`buf.readUInt16LE(0x16)`读取Audio包datalen（应为BE）
- IcomControl.ts:414 曾错误使用`buf.readUInt16LE(0x16)`读取Audio包datalen（应为BE）
- 这些错误导致160字节音频包被误读为40960字节，导致audio事件从未触发

## 调试建议

1. 当遇到数据包解析问题时，首先检查字节序是否匹配
2. 对照Java代码的**实际实现**（不是函数名）
3. 使用`hex()`工具函数打印数据包进行对比
4. 记住：TypeScript已使用正确命名，`be16/be32` = Big-Endian，`le16/le32` = Little-Endian

---

## 最近优化（2025-01-03）

### 优化1：改进disconnect()错误处理

**背景**：之前所有断开操作都使用硬编码的"User disconnect()"错误信息，导致：
- 无法区分用户主动断开、超时清理、错误断开
- 每次清理产生3次重复的Promise rejection日志
- 掩盖真实的连接错误

**改进**：
1. 新增 `DisconnectReason` 枚举（src/types.ts）：
   ```typescript
   enum DisconnectReason {
     USER_REQUEST = 'user_request',  // 用户主动
     TIMEOUT = 'timeout',             // 超时
     CLEANUP = 'cleanup',             // 清理
     ERROR = 'error',                 // 错误
     NETWORK_LOST = 'network_lost'    // 网络丢失
   }
   ```

2. 新增 `DisconnectOptions` 接口（src/types.ts）：
   ```typescript
   interface DisconnectOptions {
     reason?: DisconnectReason;
     silent?: boolean;  // 静默模式，不抛出异常
   }
   ```

3. 新增 `ConnectionAbortedError` 错误类（src/utils/errors.ts）：
   - 包含详细上下文（reason, sessionId, phase）
   - 提供语义化错误信息
   - 支持silent检查

4. 更新 `disconnect()` 方法签名：
   ```typescript
   // 向前兼容
   disconnect(): Promise<void>
   disconnect(reason: DisconnectReason): Promise<void>
   disconnect(options: DisconnectOptions): Promise<void>
   ```

5. 优化 `abortHandler` 逻辑（IcomControl.ts）：
   - 合并3个Promise rejection为1个（消除日志噪音）
   - 支持silent模式（清理时不抛异常）
   - 使用ConnectionAbortedError提供详细上下文

**Breaking Change**（小幅）：
- ❌ 错误信息从"User disconnect()"变为语义化消息（如"Connection cleanup"）
- ✅ disconnect()仍可无参数调用（向后兼容）

**使用示例**：
```typescript
// 用户主动断开（默认）
await rig.disconnect();

// 超时清理（提供原因）
await rig.disconnect(DisconnectReason.TIMEOUT);

// 静默清理（不抛异常）
await rig.disconnect({ reason: DisconnectReason.CLEANUP, silent: true });
```

### 优化2：修复Session.resetState()定时器泄漏

**问题**：resetState()重置状态但未停止定时器，可能导致重连时旧定时器仍在运行。

**修复**：在resetState()开始处调用stopTimers()。

**影响**：防止重连时定时器泄漏和重复ping/idle包。

---

最后更新：2025-01-03
