/**
 * Panasonic Kaseikyo 协议：引导 3500/1750，位 mark 432，
 * 0=432 space，1=1296 space，48 位（6 字节），LSB first（按字节）。
 * 布局：
 *   byte0-1: 厂商码 0x2002（Panasonic）
 *   byte2-3: 16 位地址（设备码）
 *   byte4:   8 位命令
 *   byte5:   校验 = byte2^byte3^byte4
 */
import { bitsToInt, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const KASEIKYO_TIMING = { header: [3500, 1750] as [number, number], mark: 432, zero: 432, one: 1296 };

export function decodeKaseikyo(pulses: number[], tol: number): RawDecode | null {
  const r = decodeBits(
    pulses,
    { header: KASEIKYO_TIMING.header, mark: KASEIKYO_TIMING.mark, zero: KASEIKYO_TIMING.zero, one: KASEIKYO_TIMING.one, count: 48 },
    tol,
  );
  if (!r) return null;
  const b = r.bits;
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) bytes.push(bitsToInt(b.slice(i * 8, i * 8 + 8)));
  const vendor = bytes[0] | (bytes[1] << 8);
  if ((bytes[2] ^ bytes[3] ^ bytes[4]) !== bytes[5]) return null;
  const protocol = vendor === 0x2002 ? 'PANASONIC' : 'KASEIKYO';
  return {
    protocol,
    variant: 'Kaseikyo',
    address: bytes[2] | (bytes[3] << 8),
    command: bytes[4],
    extra: { vendor },
    confidence: r.fit,
  };
}

export function encodePanasonic(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const b2 = address & 0xff;
  const b3 = (address >> 8) & 0xff;
  const b4 = command & 0xff;
  const bytes = [0x02, 0x20, b2, b3, b4, b2 ^ b3 ^ b4];
  const bits: number[] = [];
  for (const byte of bytes) bits.push(...intToBits(byte, 8));
  const pulses: number[] = [KASEIKYO_TIMING.header[0], KASEIKYO_TIMING.header[1]];
  for (const bit of bits) pulses.push(KASEIKYO_TIMING.mark, bit ? KASEIKYO_TIMING.one : KASEIKYO_TIMING.zero);
  pulses.push(KASEIKYO_TIMING.mark);
  return { pulses, carrierHz: 36700 };
}
