/**
 * radix-2 FFT 与载波包络频谱估计。
 * carrierSpectrum：把 PulseTrain 重采样为 1MHz 的 0/1 包络，
 * 做 FFT 后在 [loHz, hiHz] 区间按 stepHz 取幅值（mark 内载波周期结构的频谱）。
 */
import type { PulseTrain } from '../types/ir';

/** 大于等于 n 的最小 2 的幂 */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * 就地迭代 radix-2 FFT（Cooley-Tukey）。长度必须为 2 的幂。
 * sign=-1 正变换，sign=1 逆变换（不除以 N）。
 */
export function fftInPlace(re: Float64Array, im: Float64Array, sign: -1 | 1 = -1): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0 || n < 2) {
    throw new Error('fftInPlace: 长度必须为 2 的幂');
  }
  // 位反转重排
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      for (let k = 0; k < half; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + half] * curWr - im[i + k + half] * curWi;
        const bI = re[i + k + half] * curWi + im[i + k + half] * curWr;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + half] = aR - bR;
        im[i + k + half] = aI - bI;
        const nwr = curWr * wr - curWi * wi;
        curWi = curWr * wi + curWi * wr;
        curWr = nwr;
      }
    }
  }
}

/** 实数序列 FFT 幅值谱（零填充到 2 的幂），返回前 N/2 个 bin 的 |X| 与 bin 宽度 */
export function fftMagnitudes(
  samples: number[],
  sampleRateHz = 1,
): { mags: Float64Array; binHz: number; n: number } {
  const n = nextPow2(Math.max(2, samples.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(samples.slice(0, n));
  fftInPlace(re, im, -1);
  const mags = new Float64Array(n >> 1);
  for (let i = 0; i < mags.length; i++) mags[i] = Math.hypot(re[i], im[i]);
  return { mags, binHz: sampleRateHz / n, n };
}

/** 包络采样率 1MHz（1µs 分辨率） */
const ENVELOPE_FS = 1_000_000;
/** FFT 最大点数（约 131ms 信号） */
const MAX_FFT_SIZE = 1 << 17;

export interface SpectrumPoint {
  freq: number;
  magnitude: number;
}

/**
 * 载波包络频谱：把脉宽时间线重采样为 1MHz 0/1 包络（mark=1, space=0），
 * FFT 后在 [loHz, hiHz] 内每 stepHz 取邻域最大幅值。
 * 对已解调的宽 mark 信号，30-56kHz 区间幅值接近噪声底，调用方可据此回退。
 */
export function carrierSpectrum(
  train: PulseTrain,
  loHz = 30000,
  hiHz = 56000,
  stepHz = 250,
): SpectrumPoint[] {
  const totalUs = train.pulses.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(totalUs) || totalUs < 64) return [];

  const n = Math.min(MAX_FFT_SIZE, nextPow2(Math.ceil(totalUs)));
  const env = new Float64Array(n);
  // 填充包络：偶数下标 mark=1，奇数 space=0，支持小数时长
  {
    let idx = 0; // 脉冲下标
    let boundary = train.pulses[0] ?? 0; // 当前脉冲结束位置（µs）
    const limit = Math.min(n, Math.ceil(totalUs));
    for (let us = 0; us < limit; us++) {
      while (us >= boundary && idx < train.pulses.length - 1) {
        idx++;
        boundary += train.pulses[idx];
      }
      env[us] = idx % 2 === 0 ? 1 : 0;
    }
  }

  const re = env;
  const im = new Float64Array(n);
  fftInPlace(re, im, -1);

  const binHz = ENVELOPE_FS / n;
  const out: SpectrumPoint[] = [];
  const halfBins = n >> 1;
  for (let f = loHz; f <= hiHz + 1e-9; f += stepHz) {
    const center = Math.round(f / binHz);
    if (center >= halfBins) break;
    // 取 ±1 bin 邻域最大值，降低栅栏效应
    let mag = 0;
    for (let b = Math.max(1, center - 1); b <= Math.min(halfBins - 1, center + 1); b++) {
      const m = Math.hypot(re[b], im[b]);
      if (m > mag) mag = m;
    }
    out.push({ freq: Math.round(f), magnitude: mag });
  }
  return out;
}
