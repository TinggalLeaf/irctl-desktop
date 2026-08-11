/**
 * Gree 空调协议：引导 9000/4500，位 mark 620，0=540 space，1=1620 space，
 * 64 位（LSB first），第 32 位后有连接符 620 mark + ~19980 space。
 * address/command 取前两个字节，完整 8 字节状态放 extra.data。
 */
import { bitsToInt, bytesToHex, decodeBits, intToBits } from './util';
import type { RawDecode } from './util';

export const GREE_TIMING = {
  header: [9000, 4500] as [number, number],
  mark: 620,
  zero: 540,
  one: 1620,
  midMark: 620,
  midSpace: 19980,
};

export function decodeGree(pulses: number[], tol: number): RawDecode | null {
  const r = decodeBits(
    pulses,
    {
      header: GREE_TIMING.header,
      mark: GREE_TIMING.mark,
      zero: GREE_TIMING.zero,
      one: GREE_TIMING.one,
      count: 64,
      mid: { after: 32, mark: GREE_TIMING.midMark, minSpace: GREE_TIMING.midSpace * 0.5 },
    },
    tol,
  );
  if (!r) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) bytes.push(bitsToInt(r.bits.slice(i * 8, i * 8 + 8)));
  return {
    protocol: 'GREE',
    address: bytes[0],
    command: bytes[4],
    extra: { data: bytesToHex(bytes) },
    confidence: r.fit,
  };
}

/** address → 低 4 字节（LE），command → 高 4 字节（LE） */
export function encodeGree(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const bytes: number[] = [];
  for (let i = 0; i < 4; i++) bytes.push((address >>> (i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) bytes.push((command >>> (i * 8)) & 0xff);
  const bits: number[] = [];
  for (const byte of bytes) bits.push(...intToBits(byte, 8));
  const pulses: number[] = [GREE_TIMING.header[0], GREE_TIMING.header[1]];
  for (let b = 0; b < bits.length; b++) {
    if (b === 32) pulses.push(GREE_TIMING.midMark, GREE_TIMING.midSpace);
    pulses.push(GREE_TIMING.mark, bits[b] ? GREE_TIMING.one : GREE_TIMING.zero);
  }
  pulses.push(GREE_TIMING.mark);
  return { pulses, carrierHz: 38000 };
}
