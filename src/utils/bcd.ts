/**
 * BCD (Binary Coded Decimal) parsing utilities
 * Based on FT8CN's IcomRigConstant.java twoByteBcdToInt()
 */

/**
 * Parse a two-byte BCD encoded value to integer
 *
 * BCD format encodes decimal digits as nibbles (4-bit values):
 * - Byte 0: thousands (high nibble) + hundreds (low nibble)
 * - Byte 1: tens (high nibble) + ones (low nibble)
 *
 * @param data - Buffer containing at least 2 bytes of BCD data
 * @returns Parsed integer value, or 0 if data is invalid
 *
 * @example
 * // Buffer [0x12, 0x34] represents 1234
 * const value = parseTwoByteBcd(Buffer.from([0x12, 0x34]));
 * console.log(value); // 1234
 *
 * @example
 * // Buffer [0x02, 0x40] represents 240 (SWR 2.40)
 * const swr = parseTwoByteBcd(Buffer.from([0x02, 0x40]));
 * console.log(swr / 100); // 2.40
 */
export function parseTwoByteBcd(data: Buffer): number {
  if (data.length < 2) return 0;

  // Extract nibbles from each byte
  const ones = data[1] & 0x0f;           // Low nibble of byte 1
  const tens = (data[1] >> 4) & 0x0f;    // High nibble of byte 1
  const hundreds = data[0] & 0x0f;       // Low nibble of byte 0
  const thousands = (data[0] >> 4) & 0x0f; // High nibble of byte 0

  return ones + tens * 10 + hundreds * 100 + thousands * 1000;
}

/**
 * Convert integer to two-byte BCD format
 *
 * @param value - Integer value (0-9999)
 * @returns Buffer containing 2 bytes of BCD data
 *
 * @example
 * const bcd = intToTwoByteBcd(1234);
 * console.log(bcd); // Buffer [0x12, 0x34]
 */
export function intToTwoByteBcd(value: number): Buffer {
  // Clamp to valid range
  const val = Math.max(0, Math.min(9999, Math.floor(value)));

  const ones = val % 10;
  const tens = Math.floor((val % 100) / 10);
  const hundreds = Math.floor((val % 1000) / 100);
  const thousands = Math.floor(val / 1000);

  const byte0 = (thousands << 4) | hundreds;
  const byte1 = (tens << 4) | ones;

  return Buffer.from([byte0, byte1]);
}
