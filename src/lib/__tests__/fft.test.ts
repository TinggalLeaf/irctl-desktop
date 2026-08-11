import { describe, expect, it } from 'vitest';
import { carrierSpectrum, fftInPlace, fftMagnitudes, nextPow2 } from '../fft';
import type { PulseTrain } from '../../types/ir';

describe('radix-2 FFT', () => {
  it('nextPow2', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(1024)).toBe(1024);
  });

  it('单频余弦的峰值落在对应 bin', () => {
    const n = 256;
    const k = 10;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);
    fftInPlace(re, im);
    let peakBin = 0;
    let peakMag = 0;
    for (let i = 0; i < n / 2; i++) {
      const m = Math.hypot(re[i], im[i]);
      if (m > peakMag) {
        peakMag = m;
        peakBin = i;
      }
    }
    expect(peakBin).toBe(k);
    expect(peakMag).toBeCloseTo(n / 2, 0);
  });

  it('非 2 幂长度抛错', () => {
    expect(() => fftInPlace(new Float64Array(3), new Float64Array(3))).toThrow();
  });

  it('fftMagnitudes 返回 binHz', () => {
    const { mags, binHz } = fftMagnitudes([1, 0, -1, 0], 4000);
    expect(mags.length).toBe(2);
    expect(binHz).toBe(1000);
  });
});

describe('carrierSpectrum 载波包络频谱', () => {
  it('38kHz 方波时间线峰值在 38000Hz', () => {
    const half = 1_000_000 / 38000 / 2;
    const pulses: number[] = [];
    for (let i = 0; i < 3800; i++) pulses.push(half);
    const train: PulseTrain = { carrierHz: 38000, pulses };
    const spec = carrierSpectrum(train);
    expect(spec.length).toBeGreaterThan(50);
    expect(spec[0].freq).toBe(30000);
    expect(spec[spec.length - 1].freq).toBe(56000);
    let peak = spec[0];
    for (const p of spec) if (p.magnitude > peak.magnitude) peak = p;
    expect(Math.abs(peak.freq - 38000)).toBeLessThanOrEqual(500);
  });

  it('40kHz 方波峰值在 40000Hz', () => {
    const half = 1_000_000 / 40000 / 2;
    const pulses: number[] = [];
    for (let i = 0; i < 4000; i++) pulses.push(half);
    const spec = carrierSpectrum({ carrierHz: 40000, pulses });
    let peak = spec[0];
    for (const p of spec) if (p.magnitude > peak.magnitude) peak = p;
    expect(Math.abs(peak.freq - 40000)).toBeLessThanOrEqual(500);
  });

  it('过短信号返回空数组', () => {
    expect(carrierSpectrum({ carrierHz: 38000, pulses: [10, 10] })).toEqual([]);
  });
});
