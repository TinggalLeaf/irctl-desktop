/**
 * Sony SIRC 协议（12/15/20 位）。
 * 引导 2400/600；位由 mark 宽度区分：0=600，1=1200；space 恒 600；LSB first。
 * SIRC-12: 7 位命令 + 5 位地址
 * SIRC-15: 7 位命令 + 8 位地址
 * SIRC-20: 7 位命令 + 5 位地址 + 8 位扩展
 */
import { bitsToInt, intToBits, near, relErr } from './util';
import type { RawDecode } from './util';

export const SIRC_TIMING = { headerMark: 2400, headerSpace: 600, zero: 600, one: 1200, space: 600 };

export function decodeSony(pulses: number[], tol: number): RawDecode | null {
  if (pulses.length < 2) return null;
  if (!near(pulses[0], SIRC_TIMING.headerMark, tol)) return null;
  if (!near(pulses[1], SIRC_TIMING.headerSpace, tol)) return null;

  const bits: number[] = [];
  let errSum = relErr(pulses[0], SIRC_TIMING.headerMark) + relErr(pulses[1], SIRC_TIMING.headerSpace);
  let errN = 2;
  let i = 2;
  // 连续读取位，直到结构破坏（帧尾长 space）
  while (i + 1 < pulses.length) {
    const m = pulses[i];
    const s = pulses[i + 1];
    let bit: number;
    if (near(m, SIRC_TIMING.one, tol)) bit = 1;
    else if (near(m, SIRC_TIMING.zero, tol)) bit = 0;
    else break;
    if (!near(s, SIRC_TIMING.space, tol)) break;
    bits.push(bit);
    errSum += relErr(m, bit ? SIRC_TIMING.one : SIRC_TIMING.zero) + relErr(s, SIRC_TIMING.space);
    errN += 2;
    i += 2;
  }

  const n = bits.length;
  if (n !== 12 && n !== 15 && n !== 20) return null;
  const command = bitsToInt(bits.slice(0, 7));
  let address: number;
  let extended: number | undefined;
  if (n === 12) {
    address = bitsToInt(bits.slice(7, 12));
  } else if (n === 15) {
    address = bitsToInt(bits.slice(7, 15));
  } else {
    address = bitsToInt(bits.slice(7, 12));
    extended = bitsToInt(bits.slice(12, 20));
  }
  const fit = Math.max(0, Math.min(1, 1 - (errSum / errN) * 2));
  return {
    protocol: 'SONY',
    variant: `SIRC-${n}`,
    address,
    command,
    extra: extended !== undefined ? { extended } : undefined,
    confidence: fit,
  };
}

/** variant: '12' | '15' | '20' | 'SIRC-12' ...，默认 12 位 */
export function encodeSony(address: number, command: number, variant?: string): { pulses: number[]; carrierHz: number } {
  const m = /(\d+)/.exec(variant ?? '12');
  const n = m ? parseInt(m[1], 10) : 12;
  const t = SIRC_TIMING;
  let bits: number[];
  if (n === 15) {
    bits = [...intToBits(command & 0x7f, 7), ...intToBits(address & 0xff, 8)];
  } else if (n === 20) {
    bits = [...intToBits(command & 0x7f, 7), ...intToBits(address & 0x1f, 5), ...intToBits((address >> 5) & 0xff, 8)];
  } else {
    bits = [...intToBits(command & 0x7f, 7), ...intToBits(address & 0x1f, 5)];
  }
  const pulses: number[] = [t.headerMark, t.headerSpace];
  for (const bit of bits) pulses.push(bit ? t.one : t.zero, t.space);
  return { pulses, carrierHz: 40000 };
}
