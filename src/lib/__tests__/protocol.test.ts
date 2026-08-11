import { describe, expect, it } from 'vitest';
import type { PulseTrain } from '../../types/ir';
import {
  decodeFrames,
  encodeFrame,
  encodeNecRepeat,
  estimateCarrier,
  glitchFilter,
} from '../protocol';

describe('NEC 编码→解码 roundtrip', () => {
  it('地址 0x00 命令 0xAD', () => {
    const train = encodeFrame('NEC', 0x00, 0xad);
    expect(train.pulses[0]).toBeCloseTo(9000, -1);
    expect(train.pulses[1]).toBeCloseTo(4500, -1);
    const frames = decodeFrames(train);
    expect(frames.length).toBeGreaterThan(0);
    const top = frames[0];
    expect(top.protocol).toBe('NEC');
    expect(top.address).toBe(0x00);
    expect(top.command).toBe(0xad);
    expect(top.confidence).toBeGreaterThan(0.9);
  });

  it('地址 0xBF 命令 0x40', () => {
    const frames = decodeFrames(encodeFrame('NEC', 0xbf, 0x40));
    expect(frames[0].protocol).toBe('NEC');
    expect(frames[0].address).toBe(0xbf);
    expect(frames[0].command).toBe(0x40);
  });

  it('NECext 16 位地址', () => {
    const frames = decodeFrames(encodeFrame('NECext', 0x1234, 0x56));
    expect(frames[0].protocol).toBe('NECext');
    expect(frames[0].address).toBe(0x1234);
    expect(frames[0].command).toBe(0x56);
  });

  it('带重复帧时多数表决提升置信度', () => {
    const single = decodeFrames(encodeFrame('NEC', 0x00, 0xad));
    const frame = encodeFrame('NEC', 0x00, 0xad).pulses;
    const repeat = encodeNecRepeat();
    const train: PulseTrain = {
      carrierHz: 38000,
      pulses: [...frame, 45000, ...repeat, 108000, ...repeat, 108000],
    };
    const multi = decodeFrames(train);
    expect(multi[0].protocol).toBe('NEC');
    expect(multi[0].command).toBe(0xad);
    expect(multi[0].confidence).toBeGreaterThanOrEqual(single[0].confidence);
  });

  it('毛刺过滤后仍可解码', () => {
    const clean = encodeFrame('NEC', 0x10, 0x20).pulses;
    // 在第 10 个脉冲（mark 560）中插入 40µs 毛刺：560 → 300, 40, 220
    const noisy = [...clean.slice(0, 10), 300, 40, 220, ...clean.slice(11)];
    const frames = decodeFrames({ carrierHz: 38000, pulses: noisy });
    expect(frames[0].protocol).toBe('NEC');
    expect(frames[0].command).toBe(0x20);
    // glitchFilter 本身：300+40+220 合并回 560
    expect(glitchFilter([9000, 4500, 300, 40, 220, 560], 80)).toEqual([9000, 4500, 560, 560]);
  });

  it('±25% 容差内的时间偏移仍可解码', () => {
    const train = encodeFrame('NEC', 0x00, 0xad);
    const skewed = train.pulses.map((d) => d * 1.2);
    const frames = decodeFrames({ carrierHz: 38000, pulses: skewed });
    expect(frames[0].protocol).toBe('NEC');
    expect(frames[0].command).toBe(0xad);
  });
});

describe('Sony SIRC roundtrip', () => {
  it('SIRC-12', () => {
    const frames = decodeFrames(encodeFrame('SONY', 1, 12, { variant: '12' }));
    const top = frames[0];
    expect(top.protocol).toBe('SONY');
    expect(top.protocolVariant).toBe('SIRC-12');
    expect(top.address).toBe(1);
    expect(top.command).toBe(12);
  });

  it('SIRC-15 / SIRC-20 variant 分别标注', () => {
    const f15 = decodeFrames(encodeFrame('SONY', 0x53, 21, { variant: '15' }));
    expect(f15[0].protocolVariant).toBe('SIRC-15');
    expect(f15[0].address).toBe(0x53);
    const f20 = decodeFrames(encodeFrame('SONY', 0x1a, 47, { variant: '20' }));
    expect(f20[0].protocolVariant).toBe('SIRC-20');
    expect(f20[0].address).toBe(0x1a & 0x1f);
    expect(f20[0].extra?.extended).toBe((0x1a >> 5) & 0xff);
  });
});

describe('RC5 / RC5X / RC6 roundtrip', () => {
  it('RC5 地址 3 命令 12', () => {
    const frames = decodeFrames(encodeFrame('RC5', 3, 12));
    const top = frames[0];
    expect(top.protocol).toBe('RC5');
    expect(top.address).toBe(3);
    expect(top.command).toBe(12);
  });

  it('RC5X 扩展命令（>=64）', () => {
    const frames = decodeFrames(encodeFrame('RC5X', 5, 100));
    expect(frames[0].protocol).toBe('RC5X');
    expect(frames[0].command).toBe(100);
  });

  it('RC6 mode0', () => {
    const frames = decodeFrames(encodeFrame('RC6', 0x23, 0x45));
    const top = frames[0];
    expect(top.protocol).toBe('RC6');
    expect(top.protocolVariant).toBe('mode0');
    expect(top.address).toBe(0x23);
    expect(top.command).toBe(0x45);
  });
});

describe('其余协议 roundtrip', () => {
  const cases: Array<[string, number, number]> = [
    ['SAMSUNG', 0x07, 0x99],
    ['PANASONIC', 0x4004, 0x56],
    ['JVC', 0x03, 0xc5],
    ['SHARP', 0x12, 0x42],
    ['GREE', 0x12345678, 0x09abcdef & 0xffffffff],
    ['MIDEA', 0xb2, 0x4d],
  ];
  for (const [proto, addr, cmd] of cases) {
    it(`${proto} 地址 ${addr} 命令 ${cmd}`, () => {
      const frames = decodeFrames(encodeFrame(proto, addr, cmd));
      expect(frames.length).toBeGreaterThan(0);
      const top = frames[0];
      expect(top.protocol).toBe(proto);
      if (proto === 'GREE') {
        expect(top.address).toBe(addr & 0xff);
        expect(top.command).toBe((cmd >>> 0) & 0xff);
      } else {
        expect(top.address).toBe(addr);
        expect(top.command).toBe(cmd);
      }
    });
  }
});

describe('estimateCarrier 载波估计', () => {
  it('38kHz 调制时间线 → 估计值 ≈ 38000', () => {
    // 38kHz 方波：半周期 13.1579µs，持续约 50ms
    const half = 1_000_000 / 38000 / 2;
    const pulses: number[] = [];
    for (let i = 0; i < 3800; i++) pulses.push(half);
    const train: PulseTrain = { carrierHz: 38000, pulses };
    const est = estimateCarrier(train);
    expect(Math.abs(est - 38000)).toBeLessThanOrEqual(500);
  });

  it('已解调宽脉冲（无载波信息）回退到标称载波', () => {
    const train = encodeFrame('NEC', 0, 0xad);
    expect(estimateCarrier(train)).toBe(38000);
  });
});
