/**
 * NEC / NECext / NEC42 协议。
 * 引导 9000/4500，位 mark 560，0=560 space，1=1690 space，LSB first。
 * NEC:    8 位地址 + ~地址 + 8 位命令 + ~命令（32 位）
 * NECext: 16 位地址（无反码）+ 8 位命令 + ~命令（32 位）
 * NEC42:  13 位地址 + ~地址(13) + 8 位命令 + ~命令（42 位）
 * 重复帧：9000/2250 + 560 mark
 */
import { bitsToInt, decodeBits, intToBits, near } from './util';
import type { RawDecode } from './util';

export const NEC_TIMING = { headerMark: 9000, headerSpace: 4500, mark: 560, zero: 560, one: 1690 };

export function decodeNec(pulses: number[], tol: number): RawDecode | null {
  // NEC 重复帧
  if (
    pulses.length >= 2 &&
    pulses.length <= 4 &&
    near(pulses[0], NEC_TIMING.headerMark, tol) &&
    near(pulses[1], 2250, tol)
  ) {
    return {
      protocol: 'NEC',
      variant: 'repeat',
      extra: { repeat: true },
      confidence: 0.5,
    };
  }

  // 先试 NEC42（42 位）
  const r42 = decodeBits(
    pulses,
    { header: [NEC_TIMING.headerMark, NEC_TIMING.headerSpace], mark: NEC_TIMING.mark, zero: NEC_TIMING.zero, one: NEC_TIMING.one, count: 42 },
    tol,
  );
  if (r42) {
    const b = r42.bits;
    const addr = bitsToInt(b.slice(0, 13));
    const addrInv = bitsToInt(b.slice(13, 26));
    const cmd = bitsToInt(b.slice(26, 34));
    const cmdInv = bitsToInt(b.slice(34, 42));
    if ((addr ^ addrInv) === 0x1fff && (cmd ^ cmdInv) === 0xff) {
      return { protocol: 'NEC42', address: addr, command: cmd, confidence: r42.fit };
    }
  }

  // 32 位 NEC / NECext（帧长 67-68；更长的是 Gree 等其他协议，直接排除）
  if (pulses.length > 72) return null;
  const r = decodeBits(
    pulses,
    { header: [NEC_TIMING.headerMark, NEC_TIMING.headerSpace], mark: NEC_TIMING.mark, zero: NEC_TIMING.zero, one: NEC_TIMING.one, count: 32 },
    tol,
  );
  if (!r) return null;
  const b = r.bits;
  const a0 = bitsToInt(b.slice(0, 8));
  const a1 = bitsToInt(b.slice(8, 16));
  const c0 = bitsToInt(b.slice(16, 24));
  const c1 = bitsToInt(b.slice(24, 32));
  if ((c0 ^ c1) !== 0xff) return null; // 命令反码必须成立
  if ((a0 ^ a1) === 0xff) {
    return { protocol: 'NEC', address: a0, command: c0, confidence: r.fit };
  }
  // 地址反码不成立 → 16 位扩展地址
  return { protocol: 'NECext', address: a0 | (a1 << 8), command: c0, confidence: r.fit * 0.98 };
}

export interface EncodeOut {
  pulses: number[];
  carrierHz: number;
}

/** ext=true 时地址按 16 位无反码发送（NECext） */
export function encodeNec(address: number, command: number, ext = false): EncodeOut {
  const t = NEC_TIMING;
  const a0 = address & 0xff;
  const a1 = ext ? (address >> 8) & 0xff : a0 ^ 0xff;
  const c0 = command & 0xff;
  const c1 = c0 ^ 0xff;
  const bits = [
    ...intToBits(a0, 8),
    ...intToBits(a1, 8),
    ...intToBits(c0, 8),
    ...intToBits(c1, 8),
  ];
  const pulses: number[] = [t.headerMark, t.headerSpace];
  for (const bit of bits) pulses.push(t.mark, bit ? t.one : t.zero);
  pulses.push(t.mark); // 结束 mark
  return { pulses, carrierHz: 38000 };
}

/** NEC 重复帧 */
export function encodeNecRepeat(): number[] {
  return [NEC_TIMING.headerMark, 2250, NEC_TIMING.mark];
}
