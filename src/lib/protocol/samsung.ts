/**
 * Samsung 协议：引导 4500/4500，32 位 NEC 位时序（LSB first），
 * 地址两字节重复（非反码），命令 + ~命令。
 */
import { bitsToInt, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const SAMSUNG_TIMING = { header: [4500, 4500] as [number, number], mark: 560, zero: 560, one: 1690 };

export function decodeSamsung(pulses: number[], tol: number): RawDecode | null {
  // Samsung 帧长 67-68；更长的是 Midea 等引导头相近的协议
  if (pulses.length > 72) return null;
  const r = decodeBits(pulses, { header: SAMSUNG_TIMING.header, mark: 560, zero: 560, one: 1690, count: 32 }, tol);
  if (!r) return null;
  const b = r.bits;
  const a0 = bitsToInt(b.slice(0, 8));
  const a1 = bitsToInt(b.slice(8, 16));
  const c0 = bitsToInt(b.slice(16, 24));
  const c1 = bitsToInt(b.slice(24, 32));
  if (a0 !== a1 || (c0 ^ c1) !== 0xff) return null;
  return { protocol: 'SAMSUNG', address: a0, command: c0, confidence: r.fit };
}

export function encodeSamsung(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const a = address & 0xff;
  const c = command & 0xff;
  const bits = [
    ...intToBits(a, 8),
    ...intToBits(a, 8),
    ...intToBits(c, 8),
    ...intToBits(c ^ 0xff, 8),
  ];
  const pulses: number[] = [SAMSUNG_TIMING.header[0], SAMSUNG_TIMING.header[1]];
  for (const bit of bits) pulses.push(SAMSUNG_TIMING.mark, bit ? SAMSUNG_TIMING.one : SAMSUNG_TIMING.zero);
  pulses.push(SAMSUNG_TIMING.mark);
  return { pulses, carrierHz: 38000 };
}
