/**
 * Pioneer 协议：引导 8500/4225，位时序同 NEC（mark 560，0=560，1=1690），
 * 32 位 LSB first：地址 + ~地址 + 命令 + ~命令。
 */
import { bitsToInt, decodeBits } from './util';
import type { RawDecode } from './util';

export const PIONEER_TIMING = { header: [8500, 4225] as [number, number], mark: 560, zero: 560, one: 1690 };

export function decodePioneer(pulses: number[], tol: number): RawDecode | null {
  const r = decodeBits(
    pulses,
    { header: PIONEER_TIMING.header, mark: PIONEER_TIMING.mark, zero: PIONEER_TIMING.zero, one: PIONEER_TIMING.one, count: 32 },
    tol,
  );
  if (!r) return null;
  const b = r.bits;
  const a0 = bitsToInt(b.slice(0, 8));
  const a1 = bitsToInt(b.slice(8, 16));
  const c0 = bitsToInt(b.slice(16, 24));
  const c1 = bitsToInt(b.slice(24, 32));
  if ((a0 ^ a1) !== 0xff || (c0 ^ c1) !== 0xff) return null;
  return { protocol: 'PIONEER', address: a0, command: c0, confidence: r.fit };
}
