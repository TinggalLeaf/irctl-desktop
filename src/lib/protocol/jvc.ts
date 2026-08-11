/**
 * JVC 协议：引导 8400/4200，位 mark 526，0=526 space，1=1578 space，
 * 16 位 LSB first：8 位地址 + 8 位命令。
 */
import { bitsToInt, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const JVC_TIMING = { header: [8400, 4200] as [number, number], mark: 526, zero: 526, one: 1578 };

export function decodeJvc(pulses: number[], tol: number): RawDecode | null {
  // JVC 帧长 35-36；更长的是 Pioneer 等引导头相近的协议
  if (pulses.length > 40) return null;
  const r = decodeBits(
    pulses,
    { header: JVC_TIMING.header, mark: JVC_TIMING.mark, zero: JVC_TIMING.zero, one: JVC_TIMING.one, count: 16 },
    tol,
  );
  if (!r) return null;
  return {
    protocol: 'JVC',
    address: bitsToInt(r.bits.slice(0, 8)),
    command: bitsToInt(r.bits.slice(8, 16)),
    confidence: r.fit,
  };
}

export function encodeJvc(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const bits = [...intToBits(address & 0xff, 8), ...intToBits(command & 0xff, 8)];
  const pulses: number[] = [JVC_TIMING.header[0], JVC_TIMING.header[1]];
  for (const bit of bits) pulses.push(JVC_TIMING.mark, bit ? JVC_TIMING.one : JVC_TIMING.zero);
  pulses.push(JVC_TIMING.mark);
  return { pulses, carrierHz: 38000 };
}
