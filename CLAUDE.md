# ICOM WLAN TypeScript 实现注意事项

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

最后更新：2025-01-20
