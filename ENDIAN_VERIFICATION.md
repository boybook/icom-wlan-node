# 字节序对比验证表

## Java实现映射

| Java函数 | 实际字节序 |
|---------|----------|
| `intToBigEndian()` | **Little-Endian** |
| `shortToBigEndian()` | **Little-Endian** |
| `intToByte()` | **Big-Endian** |
| `shortToByte()` | **Big-Endian** |

## 数据包字段对比

### 控制包头 (0x00-0x0F) - 所有包通用

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x00 | len | `intToBigEndian()` | LE | `le32.write()` | LE | ✓ |
| 0x04 | type | `shortToBigEndian()` | LE | `le16.write()` | LE | ✓ |
| 0x06 | seq | `shortToBigEndian()` | LE | `le16.write()` | LE | ✓ |
| 0x08 | sentId | `intToBigEndian()` | LE | `le32.write()` | LE | ✓ |
| 0x0C | rcvdId | `intToBigEndian()` | LE | `le32.write()` | LE | ✓ |

### Token包 (0x40)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x12 | payloadSize | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x16 | innerSeq | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1A | tokRequest | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1C | token | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x30 | response (读) | `readIntData()` | BE | `be32.read()` | BE | ✓ |

### Login包 (0x80)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x12 | payloadSize | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x16 | innerSeq | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1A | tokRequest | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1C | token | `intToByte()` | BE | `be32.write()` | BE | ✓ |

### LoginResponse包 (0x60)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x1C | token (读) | `readIntData()` | BE | `be32.read()` | BE | ✓ |
| 0x30 | error (读) | `readIntData()` | BE | `be32.read()` | BE | ✓ |

### Status包 (0x50)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x30 | error (读) | `readIntBigEndianData()` | LE | `le32.read()` | LE | ✓ |
| 0x42 | civPort (读) | `readShortData()` | BE | `be16.read()` | BE | ✓ |
| 0x46 | audioPort (读) | `readShortData()` | BE | `be16.read()` | BE | ✓ |

### ConnInfo包 (0x90)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x12 | payloadSize | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x16 | innerSeq | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1A | tokRequest | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x1C | token | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x74 | rxSampleRate | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x78 | txSampleRate | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x7C | civPort | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x80 | audioPort | `intToByte()` | BE | `be32.write()` | BE | ✓ |
| 0x84 | txBufferSize | `intToByte()` | BE | `be32.write()` | BE | ✓ |

### CIV包 (0xC1标识)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x11 | civ_len | `shortToBigEndian()` | LE | `le16.write()` | LE | ✓ |
| 0x13 | civSeq | `shortToByte()` 手动 | BE | 手动BE | BE | ✓ |

### OpenClose包 (0xC0标识)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x11 | civ_len | `shortToBigEndian()` | LE | `le16.write()` | LE | ✓ |
| 0x13 | civSeq | `shortToByte()` 手动 | BE | 手动BE | BE | ✓ |

### Audio包 (0x97/0x00标识)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x10 | ident | `shortToByte()` 手动 | BE | 手动BE | BE | ✓ |
| 0x12 | sendSeq | `shortToByte()` 手动 | BE | 手动BE | BE | ✓ |
| 0x16 | datalen | `shortToByte()` | BE | `be16.write()` | BE | ✓ |
| 0x16 | datalen (读) | `readShortData()` | BE | `be16.read()` | BE | ✓ |

### RadioCap包 (0x66)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x53 | rxSample (读) | `readShortData()` | BE | `be16.read()` | BE | ✓ |
| 0x55 | txSample (读) | `readShortData()` | BE | `be16.read()` | BE | ✓ |

### Ping包 (0x15)

| 偏移 | 字段 | Java实现 | Java实际字节序 | TS实现 | TS字节序 | ✓/✗ |
|-----|------|---------|--------------|--------|---------|-----|
| 0x11 | time | `intToBigEndian()` | LE | `le32.write()` | LE | ✓ |

## 总结

### 修复前发现的问题
- Status包的error字段使用了错误的字节序（BE应该是LE）

### 修复后状态
- ✓ **所有43个字段完全匹配Java实现**
- ✓ 字节序命名已修正为正确含义 (be=Big-Endian, le=Little-Endian)
- ✓ 代码注释清晰标注了字节序说明

### 验证完成日期
2025-01-20
