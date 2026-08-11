/**
 * Sharp 协议：无引导头，位 mark 320，0=680 space，1=1680 space，15 位 LSB first：
 * 5 位地址 + 8 位命令 + 1 扩展位 + 1 校验位。
 * 与 Denon 时序接近，靠拟合度区分（Sharp 时序更短）。
 */
import { bitsToInt, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const SHARP_TIMING = { mark: 320, zero: 680, one: 1680 };

export function decodeSharp(pulses: number[], tol: number): RawDecode | null {
  // 无引导头：总脉冲数必须接近 15*2(+1 结束 mark)
  if (pulses.length < 29 || pulses.length > 33) return null;
  const r = decodeBits(
    pulses,
    { mark: SHARP_TIMING.mark, zero: SHARP_TIMING.zero, one: SHARP_TIMING.one, count: 15 },
    tol,
  );
  if (!r) return null;
  const b = r.bits;
  return {
    protocol: 'SHARP',
    address: bitsToInt(b.slice(0, 5)),
    command: bitsToInt(b.slice(5, 13)),
    extra: { expansion: b[13], check: b[14] },
    confidence: r.fit,
  };
}

export function encodeSharp(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const bits = [
    ...intToBits(address & 0x1f, 5),
    ...intToBits(command & 0xff, 8),
    1, // expansion 位
    0, // check 位
  ];
  const pulses: number[] = [];
  for (const bit of bits) pulses.push(SHARP_TIMING.mark, bit ? SHARP_TIMING.one : SHARP_TIMING.zero);
  pulses.push(SHARP_TIMING.mark);
  return { pulses, carrierHz: 38000 };
}
