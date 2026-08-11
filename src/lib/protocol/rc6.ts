/**
 * RC6 / RC6A 协议（Manchester 双相编码，半位单元 444µs，与 RC5 反相）。
 * 约定：逻辑 1 = 先 space 后 mark。
 * 引导 2666 mark + 889 space；随后：起始位(1) + 3 位模式 + 双宽尾位 + 数据。
 * 模式 0：8 位地址 + 8 位命令 → RC6
 * 模式 6：32 位数据（高 16 位地址/客户码，低 16 位命令）→ RC6A
 */
import { expandManchester } from './rc5';
import type { RawDecode } from './util';
import { near } from './util';

export const RC6_UNIT = 444;
export const RC6_HEADER: [number, number] = [2666, 889];

export function decodeRc6(pulses: number[], tol: number): RawDecode | null {
  if (pulses.length < 4) return null;
  if (!near(pulses[0], RC6_HEADER[0], tol)) return null;
  if (pulses[1] < RC6_HEADER[1] * (1 - tol)) return null; // 引导 space 可能与起始位合并变长

  // 展开半位单元。起始位为 1 = space+mark，其 space 半元会并入引导 space，
  // 因此先把引导 space 按 889 截断，剩余部分补回单元流。
  const cells: boolean[] = [];
  {
    const s = pulses[1];
    const extra = s - RC6_HEADER[1];
    const extraCells = Math.round(extra / RC6_UNIT);
    for (let k = 0; k < extraCells; k++) cells.push(false);
  }
  const r = expandManchester(pulses, RC6_UNIT, tol, 90, 2);
  if (!r) return null;
  const all = cells.concat(r.cells);
  if (all.length < 16) return null;

  // 位读取：1 = space 前半（markFirst=false）
  const bitAt = (cellIdx: number): number => (all[cellIdx * 2] === false ? 1 : 0);
  const start = bitAt(0);
  if (start !== 1) return null;
  const mode = (bitAt(1) << 2) | (bitAt(2) << 1) | bitAt(3);
  // 双宽尾位占第 4、5 两个单元
  const trailer = all[8] === false ? 1 : 0;

  const readBits = (fromCell: number, count: number): number | null => {
    if ((fromCell + count) * 2 > all.length) return null;
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | bitAt(fromCell + i);
    return v;
  };

  const fit = Math.max(0, Math.min(1, 1 - r.err * 2));
  if (mode === 0) {
    // 尾位占第 4、5 两个单元，数据从第 6 单元开始
    const addr = readBits(6, 8);
    const cmd = readBits(14, 8);
    if (addr === null || cmd === null) return null;
    return { protocol: 'RC6', variant: 'mode0', address: addr, command: cmd, extra: { trailer }, confidence: fit };
  }
  if (mode === 6) {
    const data = readBits(6, 32);
    if (data === null) return null;
    return {
      protocol: 'RC6',
      variant: 'RC6A',
      address: (data >>> 16) & 0xffff,
      command: data & 0xffff,
      extra: { trailer },
      confidence: fit,
    };
  }
  return null;
}

/** RC6 mode 0 编码 */
export function encodeRc6(address: number, command: number): { pulses: number[]; carrierHz: number } {
  const trailer = 0;
  // 逻辑位：start=1, mode=000, 尾位, 地址 8 位, 命令 8 位
  const logical: number[] = [1, 0, 0, 0, trailer];
  for (let i = 7; i >= 0; i--) logical.push((address >> i) & 1);
  for (let i = 7; i >= 0; i--) logical.push((command >> i) & 1);

  // 单元流：1 = space+mark，0 = mark+space；尾位双宽
  const cells: boolean[] = [];
  for (let i = 0; i < logical.length; i++) {
    const pair: boolean[] = logical[i] ? [false, true] : [true, false];
    if (i === 4) cells.push(...pair, ...pair); // 尾位双宽
    else cells.push(...pair);
  }

  const pulses: number[] = [RC6_HEADER[0], RC6_HEADER[1]];
  // cells 以 space 开头（start=1 → space+mark），会并入引导 space
  let i = 0;
  if (!cells[0]) {
    let extra = 0;
    while (i < cells.length && !cells[i]) {
      extra += RC6_UNIT;
      i++;
    }
    pulses[1] += extra;
  }
  let cur = 0;
  for (; i < cells.length; i++) {
    if (i > 0 && cells[i] === cells[i - 1]) {
      cur += RC6_UNIT;
    } else {
      if (cur > 0) pulses.push(cur);
      cur = RC6_UNIT;
    }
  }
  if (cur > 0) pulses.push(cur);
  return { pulses, carrierHz: 36000 };
}
