/**
 * 协议识别/编码总入口。
 * decodeFrames: 毛刺过滤 → 分帧 → 各协议解码 → 重复帧多数表决 → 按置信度排序。
 * encodeFrame:  按协议名生成 PulseTrain。
 */
import type { DecodedFrame, PulseTrain } from '../../types/ir';
import {
  DEFAULT_GLITCH_US,
  DEFAULT_TOLERANCE,
  glitchFilter,
  splitFrames,
} from './util';
import type { Decoder, RawDecode } from './util';
import { decodeNec, encodeNec, encodeNecRepeat } from './nec';
import { decodeSony, encodeSony } from './sony';
import { decodeRc5, encodeRc5 } from './rc5';
import { decodeRc6, encodeRc6 } from './rc6';
import { decodeSamsung, encodeSamsung } from './samsung';
import { decodeKaseikyo, encodePanasonic } from './kaseikyo';
import { decodeJvc, encodeJvc } from './jvc';
import { decodeSharp, encodeSharp } from './sharp';
import { decodeGree, encodeGree } from './gree';
import { decodeMidea, encodeMidea } from './midea';
import { decodeDaikin } from './daikin';
import { decodePioneer } from './pioneer';
import { decodeDenon } from './denon';
import { carrierSpectrum } from '../fft';

export { glitchFilter, splitFrames, DEFAULT_TOLERANCE, DEFAULT_GLITCH_US } from './util';
export type { RawDecode, Decoder } from './util';
export { encodeNecRepeat };

const DECODERS: Decoder[] = [
  decodeNec,
  decodeRc6,
  decodeRc5,
  decodeSony,
  decodeKaseikyo,
  decodeSamsung,
  decodeGree,
  decodeMidea,
  decodeDaikin,
  decodePioneer,
  decodeJvc,
  decodeSharp,
  decodeDenon,
];

export interface DecodeOptions {
  /** 匹配容差，默认 ±25% */
  tolerance?: number;
  /** 毛刺过滤阈值（µs），短于该值的脉冲被吸收；默认 80，0 关闭 */
  glitchFilterUs?: number;
}

interface Vote {
  dec: RawDecode;
  raw: number[];
  count: number;
  /** NEC 重复帧数量（仅提升置信度，不改变结果） */
  repeats: number;
}

/**
 * 自动识别 17 种协议，按置信度降序返回。
 * 同一 (protocol, variant, address, command) 的多帧结果做多数表决并提升置信度。
 */
export function decodeFrames(train: PulseTrain, opts?: DecodeOptions): DecodedFrame[] {
  const tol = opts?.tolerance ?? DEFAULT_TOLERANCE;
  const glitchUs = opts?.glitchFilterUs ?? DEFAULT_GLITCH_US;
  const pulses = glitchFilter(train.pulses, glitchUs);
  const segments = splitFrames(pulses);

  const votes = new Map<string, Vote>();
  for (const seg of segments) {
    if (seg.length < 2) continue;
    for (const decoder of DECODERS) {
      const r = decoder(seg, tol);
      if (!r) continue;
      if (r.extra?.repeat) {
        // NEC 重复帧：给 NEC 家族所有候选加权
        for (const v of votes.values()) {
          if (v.dec.protocol.startsWith('NEC')) v.repeats++;
        }
        continue;
      }
      const key = `${r.protocol}|${r.variant ?? ''}|${r.address ?? ''}|${r.command ?? ''}`;
      const v = votes.get(key);
      if (v) {
        v.count++;
        if (r.confidence > v.dec.confidence) {
          v.dec = r;
          v.raw = seg;
        }
      } else {
        votes.set(key, { dec: r, raw: seg, count: 1, repeats: 0 });
      }
    }
  }

  const frames: DecodedFrame[] = [];
  for (const v of votes.values()) {
    // 多数表决加成：每多一帧 +8%，每个 NEC 重复帧 +3%，上限 1
    const boost = 1 + 0.08 * (v.count - 1) + 0.03 * v.repeats;
    const confidence = Math.min(1, v.dec.confidence * boost);
    frames.push({
      protocol: v.dec.protocol,
      protocolVariant: v.dec.variant,
      address: v.dec.address,
      command: v.dec.command,
      extra: { ...v.dec.extra, frameCount: v.count },
      confidence,
      raw: v.raw,
      carrierHz: train.carrierHz,
    });
  }
  frames.sort((a, b) => b.confidence - a.confidence);
  return frames;
}

export interface EncodeOptions {
  /** Sony SIRC 位宽：'12' | '15' | '20'（也接受 'SIRC-12' 形式） */
  variant?: string;
  /** 载波 Hz，缺省按协议默认（NEC 38000 / RC5 36000 / Sony 40000 ...） */
  carrierHz?: number;
}

/**
 * 协议编码。支持：NEC / NECext / SONY(SIRC 12/15/20) / RC5 / RC5X / RC6 /
 * SAMSUNG / PANASONIC(Kaseikyo) / JVC / SHARP / GREE / MIDEA。
 */
export function encodeFrame(
  protocol: string,
  address: number,
  command: number,
  opts?: EncodeOptions,
): PulseTrain {
  const name = protocol.trim().toUpperCase();
  let out: { pulses: number[]; carrierHz: number };
  switch (name) {
    case 'NEC':
      out = encodeNec(address, command, false);
      break;
    case 'NECEXT':
    case 'NEC-EXT':
    case 'NECX':
      out = encodeNec(address, command, true);
      break;
    case 'SONY':
    case 'SIRC':
    case 'SIRC-12':
    case 'SIRC-15':
    case 'SIRC-20':
      out = encodeSony(address, command, opts?.variant ?? (name.startsWith('SIRC-') ? name : undefined));
      break;
    case 'RC5':
      out = encodeRc5(address, command, false);
      break;
    case 'RC5X':
      out = encodeRc5(address, command, true);
      break;
    case 'RC6':
      out = encodeRc6(address, command);
      break;
    case 'SAMSUNG':
      out = encodeSamsung(address, command);
      break;
    case 'PANASONIC':
    case 'KASEIKYO':
      out = encodePanasonic(address, command);
      break;
    case 'JVC':
      out = encodeJvc(address, command);
      break;
    case 'SHARP':
      out = encodeSharp(address, command);
      break;
    case 'GREE':
      out = encodeGree(address, command);
      break;
    case 'MIDEA':
      out = encodeMidea(address, command);
      break;
    default:
      throw new Error(`encodeFrame: 不支持的协议 "${protocol}"`);
  }
  return { carrierHz: opts?.carrierHz ?? out.carrierHz, pulses: out.pulses };
}

/**
 * 载波频偏估计：对 mark 段包络做 30-56kHz 频谱扫描，返回峰值频率。
 * 若信号为已解调脉宽（无载波信息），返回 train.carrierHz。
 */
export function estimateCarrier(train: PulseTrain): number {
  const spectrum = carrierSpectrum(train);
  if (spectrum.length === 0) return train.carrierHz;
  let peak = spectrum[0];
  let total = 0;
  for (const p of spectrum) {
    total += p.magnitude;
    if (p.magnitude > peak.magnitude) peak = p;
  }
  // 频谱基本平坦（无显著峰值）时回退到标称载波；
  // 阈值 10：已解调宽脉冲的泄漏峰值/均值约 4-5 倍，真实载波调制约 80 倍
  if (total <= 0 || peak.magnitude < (total / spectrum.length) * 10) return train.carrierHz;
  return peak.freq;
}
