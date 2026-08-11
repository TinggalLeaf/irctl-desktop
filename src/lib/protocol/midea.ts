/**
 * Midea 空调协议：引导 4480/4480，位 mark 560，0=560 space，1=1690 space，
 * 48 位 LSB first：A, ~A, C, ~C, B, ~B。
 */
import { bitsToInt, bytesToHex, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const MIDEA_TIMING = { header: [4480, 4480] as [number, number], mark: 560, zero: 560, one: 1690 };

export function decodeMidea(pulses: number[], tol: number): RawDecode | null {
  const r = decodeBits(
    pulses,
    { header: MIDEA_TIMING.header, mark: MIDEA_TIMING.mark, zero: MIDEA_TIMING.zero, one: MIDEA_TIMING.one, count: 48 },
    tol,
  );
  if (!r) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 6; i++) bytes.push(bitsToInt(r.bits.slice(i * 8, i * 8 + 8)));
  if ((bytes[0] ^ bytes[1]) !== 0xff || (bytes[2] ^ bytes[3]) !== 0xff || (bytes[4] ^ bytes[5]) !== 0xff) {
    return null;
  }
  return {
    protocol: 'MIDEA',
    address: bytes[0],
    command: bytes[2],
    extra: { data: bytesToHex(bytes), b: bytes[4] },
    confidence: r.fit,
  };
}

export function encodeMidea(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const a = address & 0xff;
  const c = command & 0xff;
  const bytes = [a, a ^ 0xff, c, c ^ 0xff, 0, 0xff];
  const bits: number[] = [];
  for (const byte of bytes) bits.push(...intToBits(byte, 8));
  const pulses: number[] = [MIDEA_TIMING.header[0], MIDEA_TIMING.header[1]];
  for (const bit of bits) pulses.push(MIDEA_TIMING.mark, bit ? MIDEA_TIMING.one : MIDEA_TIMING.zero);
  pulses.push(MIDEA_TIMING.mark);
  return { pulses, carrierHz: 38000 };
}
