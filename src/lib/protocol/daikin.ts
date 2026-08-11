/**
 * Daikin 空调协议（简化识别）：引导 3650/1623，位 mark 434，
 * 0=434 space，1=1216 space，每块 35 位 LSB first，块间以 mark + ~29700 space 分隔。
 * 完整帧通常两块；这里识别首块/双块，完整状态放 extra.data。
 */
import { bitsToInt, bytesToHex, near, relErr } from './util';
import type { RawDecode } from './util';

export const DAIKIN_TIMING = { header: [3650, 1623] as [number, number], mark: 434, zero: 434, one: 1216 };

/** 解码单个 35 位块，返回位与消耗的下标 */
function decodeBlock(
  pulses: number[],
  start: number,
  tol: number,
): { bits: number[]; next: number; err: number } | null {
  let i = start;
  if (i + 1 >= pulses.length) return null;
  if (!near(pulses[i], DAIKIN_TIMING.header[0], tol) || !near(pulses[i + 1], DAIKIN_TIMING.header[1], tol)) {
    return null;
  }
  let err = relErr(pulses[i], DAIKIN_TIMING.header[0]) + relErr(pulses[i + 1], DAIKIN_TIMING.header[1]);
  let n = 2;
  i += 2;
  const bits: number[] = [];
  for (let b = 0; b < 35; b++) {
    if (i + 1 >= pulses.length) return null;
    if (!near(pulses[i], DAIKIN_TIMING.mark, tol)) return null;
    const s = pulses[i + 1];
    if (near(s, DAIKIN_TIMING.one, tol)) bits.push(1);
    else if (near(s, DAIKIN_TIMING.zero, tol)) bits.push(0);
    else return null;
    err += relErr(pulses[i], DAIKIN_TIMING.mark) + relErr(s, bits[bits.length - 1] ? DAIKIN_TIMING.one : DAIKIN_TIMING.zero);
    n += 2;
    i += 2;
  }
  return { bits, next: i, err: err / n };
}

export function decodeDaikin(pulses: number[], tol: number): RawDecode | null {
  const b1 = decodeBlock(pulses, 0, tol);
  if (!b1) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 4; i++) bytes.push(bitsToInt(b1.bits.slice(i * 8, i * 8 + 8)));
  let confidence = Math.max(0, Math.min(1, 1 - b1.err * 2));
  let command = bitsToInt(b1.bits.slice(16, 24));
  // 尝试第二块（块间：mark + 长 space）
  let idx = b1.next;
  if (idx + 1 < pulses.length && near(pulses[idx], DAIKIN_TIMING.mark, tol) && pulses[idx + 1] > 15000) {
    const b2 = decodeBlock(pulses, idx + 2, tol);
    if (b2) {
      for (let i = 0; i < 4; i++) bytes.push(bitsToInt(b2.bits.slice(i * 8, i * 8 + 8)));
      command = bitsToInt(b2.bits.slice(16, 24));
      confidence = Math.max(0, Math.min(1, 1 - ((b1.err + b2.err) / 2) * 2)) + 0.05;
    }
  }
  return {
    protocol: 'DAIKIN',
    address: bytes[0],
    command,
    extra: { data: bytesToHex(bytes), blocks: bytes.length / 4 },
    confidence: Math.min(1, confidence),
  };
}
