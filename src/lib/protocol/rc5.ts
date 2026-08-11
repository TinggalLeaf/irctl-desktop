/**
 * RC5 / RC5X 协议（Manchester 双相编码，半位单元 889µs）。
 * 约定：逻辑 1 = 先 mark 后 space（与常见捕获格式一致）。
 * 14 位：S1 S2 T A4..A0 C5..C0（MSB first）。
 * RC5:  S2=1，命令 0-63
 * RC5X: S2=~C6，命令 0-127
 */
import type { RawDecode } from './util';

export const RC5_UNIT = 889;

/** 把交替脉宽展开为半位单元电平序列（true=mark）。返回 null 表示结构非法 */
export function expandManchester(
  pulses: number[],
  unit: number,
  tol: number,
  maxCells: number,
  startIdx = 0,
): { cells: boolean[]; err: number } | null {
  const cells: boolean[] = [];
  let errSum = 0;
  let errN = 0;
  let level = true; // pulses[startIdx] 是 mark
  for (let i = startIdx; i < pulses.length && cells.length < maxCells; i++) {
    const d = pulses[i];
    let n = Math.round(d / unit);
    if (n < 1) {
      // 允许最后一个脉冲被截断
      if (i === pulses.length - 1) break;
      return null;
    }
    // 只在最后一个脉冲允许超过 2 个单元（帧尾长 space）
    if (n > 2 && i !== pulses.length - 1) return null;
    if (cells.length + n > maxCells) n = maxCells - cells.length;
    const err = Math.abs(d - n * unit) / (n * unit);
    // 舍入到整数单元后的偏差超容差视为非法（末脉冲允许截断）
    if (err > tol && i !== pulses.length - 1) return null;
    errSum += err;
    errN++;
    for (let k = 0; k < n; k++) cells.push(level);
    level = !level;
  }
  return { cells, err: errN > 0 ? errSum / errN : 1 };
}

/** Manchester 解码：bit = 前半单元电平（markFirst=true 时 mark 前半为 1） */
function cellsToBits(cells: boolean[], markFirst: boolean): number[] {
  const bits: number[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    bits.push((cells[i] === markFirst) ? 1 : 0);
  }
  return bits;
}

export function decodeRc5(pulses: number[], tol: number): RawDecode | null {
  const r = expandManchester(pulses, RC5_UNIT, tol, 28);
  if (!r) return null;
  const cells = r.cells;
  if (cells.length < 27) return null;
  // 帧尾缺少的半个 space 单元补齐
  if (cells.length === 27) cells.push(!cells[cells.length - 1]);
  const bits = cellsToBits(cells, true);
  if (bits.length < 14) return null;
  const [s1, s2, toggle] = bits;
  if (s1 !== 1) return null;
  let address = 0;
  for (let i = 3; i <= 7; i++) address = (address << 1) | bits[i];
  let command = 0;
  for (let i = 8; i <= 13; i++) command = (command << 1) | bits[i];
  const fit = Math.max(0, Math.min(1, 1 - r.err * 2));
  if (s2 === 1) {
    return { protocol: 'RC5', address, command, extra: { toggle }, confidence: fit };
  }
  command += 64;
  return { protocol: 'RC5X', address, command, extra: { toggle }, confidence: fit };
}

/** variant 'RC5X' 或命令 >= 64 时按 RC5X 编码 */
export function encodeRc5(address: number, command: number, extended = false): { pulses: number[]; carrierHz: number } {
  const c6 = command >= 64 ? 1 : 0;
  const cmd6 = command & 0x3f;
  const s2 = extended || c6 ? 0 : 1; // RC5X: S2 = ~C6
  const bits: number[] = [1, s2, 0]; // S1 S2 T=0
  for (let i = 4; i >= 0; i--) bits.push((address >> i) & 1);
  for (let i = 5; i >= 0; i--) bits.push((cmd6 >> i) & 1);

  // Manchester：1 = mark+space，0 = space+mark
  const cells: boolean[] = [];
  for (const b of bits) {
    if (b) cells.push(true, false);
    else cells.push(false, true);
  }
  // 压缩为交替时长
  const pulses: number[] = [];
  let cur = RC5_UNIT;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i] === cells[i - 1]) {
      cur += RC5_UNIT;
    } else {
      pulses.push(cur);
      cur = RC5_UNIT;
    }
  }
  pulses.push(cur);
  // 若以 space 结尾，PulseTrain 允许末元素为 space；若以 mark 结尾也合法
  return { pulses, carrierHz: 36000 };
}
