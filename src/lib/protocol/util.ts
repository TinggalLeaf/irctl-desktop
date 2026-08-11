/**
 * 协议解码公共工具：容差匹配、毛刺过滤、分帧、位流解码/编码。
 * 所有时长单位均为 µs。
 */

/** 默认匹配容差 ±25% */
export const DEFAULT_TOLERANCE = 0.25;
/** 默认毛刺阈值：短于该时长的脉冲被吸收合并 */
export const DEFAULT_GLITCH_US = 80;

/** 单协议解码器输出的原始结果（未带 DecodedFrame 的 raw/carrierHz） */
export interface RawDecode {
  protocol: string;
  variant?: string;
  address?: number;
  command?: number;
  extra?: Record<string, number | string | boolean>;
  /** 0-1 拟合置信度（由时长相对误差推得，重复表决在外层再加成） */
  confidence: number;
}

/** 协议解码器签名：失败返回 null */
export type Decoder = (pulses: number[], tol: number) => RawDecode | null;

/** 容差匹配：|d - t| <= t * tol */
export function near(d: number, t: number, tol: number): boolean {
  return Math.abs(d - t) <= t * tol;
}

/** 相对误差 0..1+ */
export function relErr(d: number, t: number): number {
  return t === 0 ? (d === 0 ? 0 : 1) : Math.abs(d - t) / Math.abs(t);
}

/**
 * 毛刺过滤：短于 glitchUs 的脉冲被合并吸收进相邻脉冲。
 * 交替电平序列中，毛刺及其后一个脉冲被并入前一个脉冲（保持电平交替结构）。
 */
export function glitchFilter(pulses: number[], glitchUs: number = DEFAULT_GLITCH_US): number[] {
  if (glitchUs <= 0) return pulses.slice();
  const out: number[] = [];
  for (let i = 0; i < pulses.length; i++) {
    const d = pulses[i];
    if (d < glitchUs) {
      if (out.length > 0 && i + 1 < pulses.length) {
        // 毛刺 + 后一同电平脉冲并入前一脉冲
        out[out.length - 1] += d + pulses[i + 1];
        i++;
      } else if (out.length > 0) {
        out[out.length - 1] += d; // 末尾毛刺直接吸收
      } else if (i + 1 < pulses.length) {
        out.push(d + pulses[i + 1]); // 开头毛刺向后合并
        i++;
      }
    } else {
      out.push(d);
    }
  }
  return out;
}

/**
 * 按长 space 切分帧（用于重复帧多数表决）。
 * gapUs 以上的 space 视为帧间隔；返回各帧（含结尾的长 space）。
 */
export function splitFrames(pulses: number[], gapUs = 25000): number[][] {
  const frames: number[][] = [];
  let start = 0;
  // i 为奇数下标时是 space
  for (let i = 1; i < pulses.length; i += 2) {
    if (pulses[i] > gapUs) {
      frames.push(pulses.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < pulses.length) frames.push(pulses.slice(start));
  return frames.filter((f) => f.length >= 2);
}

/** 位数组转整数。lsbFirst=true 时 bits[0] 是最低位（NEC/SIRC/JVC 等惯例） */
export function bitsToInt(bits: number[], lsbFirst = true): number {
  let v = 0;
  if (lsbFirst) {
    for (let i = bits.length - 1; i >= 0; i--) v = v * 2 + bits[i];
  } else {
    for (let i = 0; i < bits.length; i++) v = v * 2 + bits[i];
  }
  return v;
}

/** 整数转位数组（定宽）。lsbFirst=true 时 bits[0] 为最低位 */
export function intToBits(value: number, width: number, lsbFirst = true): number[] {
  const bits: number[] = [];
  for (let i = 0; i < width; i++) {
    const b = (value >>> i) & 1;
    bits.push(b);
  }
  if (!lsbFirst) bits.reverse();
  return bits;
}

/** 脉宽位解码规格（mark + 可变 space 表示 0/1，NEC 家族通用） */
export interface BitSpec {
  /** [mark, space]，null 表示无引导头 */
  header?: [number, number] | null;
  /** 位 mark 时长 */
  mark: number;
  /** 0 的 space 时长 */
  zero: number;
  /** 1 的 space 时长 */
  one: number;
  /** 总位数 */
  count: number;
  /** 帧中连接符（如 Gree）：在第 after 位之前/后插入 mark + 长 space */
  mid?: { after: number; mark: number; minSpace: number } | null;
}

export interface BitsResult {
  bits: number[];
  /** 0-1 拟合度，1 为完全吻合 */
  fit: number;
}

/**
 * 通用「固定位 mark + 0/1 两种 space」位流解码（NEC/Samsung/Pioneer/Gree/Midea/Daikin 家族）。
 * 返回 null 表示结构不匹配。
 */
export function decodeBits(pulses: number[], spec: BitSpec, tol: number): BitsResult | null {
  let i = 0;
  let errSum = 0;
  let errN = 0;
  const acc = (d: number, t: number): boolean => {
    errSum += relErr(d, t);
    errN++;
    return near(d, t, tol);
  };

  if (spec.header) {
    if (pulses.length < 2) return null;
    if (!acc(pulses[0], spec.header[0])) return null;
    if (!acc(pulses[1], spec.header[1])) return null;
    i = 2;
  }

  const bits: number[] = [];
  for (let b = 0; b < spec.count; b++) {
    if (spec.mid && b === spec.mid.after) {
      if (i + 1 >= pulses.length) return null;
      if (!acc(pulses[i], spec.mid.mark)) return null;
      if (pulses[i + 1] < spec.mid.minSpace) return null;
      i += 2;
    }
    if (i + 1 >= pulses.length) return null;
    if (!acc(pulses[i], spec.mark)) return null;
    const s = pulses[i + 1];
    if (near(s, spec.one, tol)) {
      bits.push(1);
      errSum += relErr(s, spec.one);
      errN++;
    } else if (near(s, spec.zero, tol)) {
      bits.push(0);
      errSum += relErr(s, spec.zero);
      errN++;
    } else {
      return null;
    }
    i += 2;
  }

  const avgErr = errN > 0 ? errSum / errN : 1;
  const fit = Math.max(0, Math.min(1, 1 - avgErr * 2));
  return { bits, fit };
}

/** 由位数组生成「mark + 0/1 space」脉宽序列（不含引导头/结尾） */
export function bitsToPulses(
  bits: number[],
  mark: number,
  zero: number,
  one: number,
  mid?: { after: number; mark: number; space: number } | null,
): number[] {
  const out: number[] = [];
  for (let b = 0; b < bits.length; b++) {
    if (mid && b === mid.after) out.push(mid.mark, mid.space);
    out.push(mark, bits[b] ? one : zero);
  }
  return out;
}

/** 字节数组转 hex 字符串（extra.data 用） */
export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
