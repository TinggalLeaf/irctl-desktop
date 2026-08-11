/**
 * Denon 协议：无引导头，位 mark 340，0=790 space，1=1850 space，15 位：
 * 5 位地址 + 8 位命令 + 2 扩展位。与 Sharp 时序接近，靠拟合度区分。
 * 真机通常连发两帧（第二帧高位取反），单帧也可识别。
 */
import { bitsToInt, decodeBits } from './util';
import type { RawDecode } from './util';

export const DENON_TIMING = { mark: 340, zero: 790, one: 1850 };

export function decodeDenon(pulses: number[], tol: number): RawDecode | null {
  if (pulses.length < 29 || pulses.length > 33) return null;
  const r = decodeBits(
    pulses,
    { mark: DENON_TIMING.mark, zero: DENON_TIMING.zero, one: DENON_TIMING.one, count: 15 },
    tol,
  );
  if (!r) return null;
  const b = r.bits;
  return {
    protocol: 'DENON',
    address: bitsToInt(b.slice(0, 5)),
    command: bitsToInt(b.slice(5, 13)),
    extra: { ext: bitsToInt(b.slice(13, 15)) },
    // 单帧识别置信度略降（未见取反校验帧）
    confidence: r.fit * 0.95,
  };
}
