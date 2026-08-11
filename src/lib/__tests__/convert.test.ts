import { describe, expect, it } from 'vitest';
import { convert, detectFormat, formatFromCanonical, parseToCanonical } from '../convert';
import { encodeFrame } from '../protocol';
import { MODULE_TICK_US } from '../../types/ir';

/** 用协议库生成 NEC(addr 0x00, cmd 0xAD) 的 Broadlink 0x26 包字节（已知向量） */
function necBroadlinkBytes(): number[] {
  const { pulses } = encodeFrame('NEC', 0x00, 0xad);
  const tick = 1_000_000 / 32768;
  const data: number[] = [];
  for (const d of pulses) {
    const v = Math.max(1, Math.round(d / tick));
    if (v > 0xff) data.push(0x00, (v >> 8) & 0xff, v & 0xff);
    else data.push(v);
  }
  return [0x26, 0x00, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

const NEC_BROADLINK_B64 = (() => {
  let bin = '';
  for (const b of necBroadlinkBytes()) bin += String.fromCharCode(b);
  return btoa(bin);
})();

const MODULE_SAMPLE =
  '00 69 0A 06 05 17 06 0F 05 0A 05 16 07 03 06 17 05 04 06 0F 06 04 06 04 06 03 06 04 06 04 06 09 06 04 05 05 05 17 05 04 06 09 06 09 06 16 06 04 06 16 06 09 06 04 06 03 06 04 06 04 06 04 06 16 06 16 06 04 06 04 05 05 05 04 06 04 06 04 06 04 05 0A 05 04 06 04 06 04 06 04 05 04 06 16 06 16 06 0A 05 09 06 FF FF FF FF';

describe('Pronto 0000', () => {
  it('解析已知 NEC Pronto', () => {
    const pronto =
      '0000 006D 0022 0000 0157 00AC 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0016 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0041 0015 0600';
    const sig = parseToCanonical(pronto, 'pronto');
    // 0x006D=109 → 载波 ≈ 1e6/(109*0.241246) ≈ 38028Hz
    expect(Math.abs(sig.carrierHz - 38000)).toBeLessThan(200);
    // 0x0157*26.29 ≈ 8983µs，0x00AC*26.29 ≈ 4523µs
    expect(sig.pulses[0]).toBeGreaterThan(8500);
    expect(sig.pulses[0]).toBeLessThan(9500);
    expect(sig.pulses[1]).toBeGreaterThan(4200);
    expect(sig.pulses[1]).toBeLessThan(4800);
    expect(sig.pulses.length).toBe(0x22 * 2);
  });

  it('生成→解析 roundtrip', () => {
    const original = encodeFrame('NEC', 0x00, 0xad);
    const pronto = formatFromCanonical(original, 'pronto');
    const back = parseToCanonical(pronto, 'pronto');
    expect(back.pulses.length).toBeGreaterThanOrEqual(original.pulses.length);
    for (let i = 0; i < original.pulses.length; i++) {
      expect(Math.abs(back.pulses[i] - original.pulses[i])).toBeLessThan(original.pulses[i] * 0.03 + 30);
    }
  });

  it('0100 按 raw 结构解析', () => {
    const p0100 =
      '0100 006D 0002 0000 0157 00AC 0015 0C3F';
    const sig = parseToCanonical(p0100, 'pronto');
    expect(sig.pulses[0]).toBeGreaterThan(8500);
    expect(sig.pulses[1]).toBeGreaterThan(4200);
  });
});

describe('Broadlink', () => {
  it('base64 已知向量解码（0x26 IR 包）', () => {
    const sig = parseToCanonical(NEC_BROADLINK_B64, 'broadlink_b64');
    expect(sig.pulses.length).toBe(67); // NEC 帧：2 + 64 + 1
    expect(Math.abs(sig.pulses[0] - 9000)).toBeLessThan(9000 * 0.05);
    expect(Math.abs(sig.pulses[1] - 4500)).toBeLessThan(4500 * 0.05);
  });

  it('hex 与 b64 等价', () => {
    const hex = convert(NEC_BROADLINK_B64, 'broadlink_b64', 'broadlink_hex');
    const sig = parseToCanonical(hex, 'broadlink_hex');
    expect(sig.pulses.length).toBe(67);
  });

  it('broadlink → pronto → json 管线', () => {
    const pronto = convert(NEC_BROADLINK_B64, 'broadlink_b64', 'pronto');
    expect(pronto.startsWith('0000 ')).toBe(true);
    const json = convert(pronto, 'pronto', 'json');
    const o = JSON.parse(json) as { carrier_hz: number; pulses: number[] };
    expect(Math.abs(o.carrier_hz - 38000)).toBeLessThan(500);
    expect(o.pulses.length).toBeGreaterThanOrEqual(67);
    expect(Math.abs(o.pulses[0] - 9000)).toBeLessThan(9000 * 0.06);
    // auto 检测链
    expect(detectFormat(NEC_BROADLINK_B64)).toBe('broadlink_b64');
    expect(detectFormat(pronto)).toBe('pronto');
    expect(detectFormat(json)).toBe('json');
  });
});

describe('模块 blob', () => {
  it('样例解析成 PulseTrain 不抛错', () => {
    const sig = parseToCanonical(MODULE_SAMPLE, 'module');
    expect(sig.pulses.length).toBe(0x69 - 6); // 99 个边沿
    expect(sig.pulses[0]).toBe(0x0a * MODULE_TICK_US); // 1000µs
    expect(sig.pulses[2]).toBe(0x05 * MODULE_TICK_US);
  });

  it('module ↔ CanonicalSignal 互转', () => {
    const sig = parseToCanonical(MODULE_SAMPLE, 'module');
    const hex = formatFromCanonical(sig, 'module');
    const back = parseToCanonical(hex, 'module');
    expect(back.pulses).toEqual(sig.pulses);
    expect(detectFormat(hex)).toBe('module');
  });

  it('module → raw 管线', () => {
    const raw = convert(MODULE_SAMPLE, 'module', 'raw');
    const nums = raw.split(/,\s*/).map(Number);
    expect(nums.length).toBe(99);
    expect(nums[0]).toBe(1000);
  });
});

describe('detectFormat', () => {
  const cases: Array<[string, string]> = [
    ['0000 006D 0022 0000 0157 00AC 0015 0016', 'pronto'],
    ['0100 006D 0002 0000 0157 00AC 0015 0C3F', 'pronto'],
    ['begin remote\n  name tv\n  begin raw_codes\n    name power\n    9000 4500 560 560\n  end raw_codes\nend remote', 'lirc'],
    ['{"carrierHz":38000,"pulses":[9000,4500,560,560]}', 'json'],
    ['<signal carrier="38000"><pulses>9000 4500 560 560</pulses></signal>', 'xml'],
    ['9000, 4500, 560, 560, 560, 1690', 'raw'],
    ['9000 4500 560 560', 'raw'],
    [MODULE_SAMPLE, 'module'],
    [NEC_BROADLINK_B64, 'broadlink_b64'],
    [
      '26 00 08 00 29 29 29 29 29 29 29 29',
      'broadlink_hex',
    ],
  ];
  for (const [input, expected] of cases) {
    it(`识别为 ${expected}`, () => {
      expect(detectFormat(input)).toBe(expected);
    });
  }
});

describe('lirc 与 raw/json/xml 互转', () => {
  it('lirc 解析与生成 roundtrip', () => {
    const lirc =
      'begin remote\n  name demo\n  flags RAW_CODES\n  frequency 38000\n  gap 45000\n  begin raw_codes\n    name power\n    9000 4500 560 560 560 1690 560 560\n  end raw_codes\nend remote';
    const sig = parseToCanonical(lirc, 'lirc');
    expect(sig.carrierHz).toBe(38000);
    expect(sig.pulses).toEqual([9000, 4500, 560, 560, 560, 1690, 560, 560]);
    const out = formatFromCanonical(sig, 'lirc');
    const back = parseToCanonical(out, 'lirc');
    expect(back.pulses).toEqual(sig.pulses);
    expect(back.carrierHz).toBe(38000);
  });

  it('raw → xml → raw', () => {
    const xml = convert('9000, 4500, 560, 560', 'raw', 'xml');
    expect(xml).toContain('<signal');
    const raw = convert(xml, 'xml', 'raw');
    expect(raw).toBe('9000, 4500, 560, 560');
  });

  it('convert from=auto', () => {
    const out = convert('9000, 4500, 560, 560', 'auto', 'json');
    const o = JSON.parse(out) as { pulses: number[] };
    expect(o.pulses).toEqual([9000, 4500, 560, 560]);
  });
});
