/**
 * 格式互转管线。中枢表示 CanonicalSignal { carrierHz, pulses }（µs，mark 起交替）。
 * 支持：pronto(0000/0100 raw)、lirc(raw_codes)、broadlink_hex/broadlink_b64(0x26 IR 包)、
 * raw(µs 数组)、json、xml、module(模块 blob hex)。
 */
import { MODULE_TICK_US } from '../../types/ir';
import type { CanonicalSignal, ConvertFormat } from '../../types/ir';

const DEFAULT_CARRIER = 38000;
/** Pronto 时间字单位：1 个计数 = 0.241246µs × 频率字 */
const PRONTO_TICK = 0.241246;
/** Broadlink 时间单位：2^-15 s ≈ 30.5176µs */
const BROADLINK_TICK_US = 1_000_000 / 32768;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function bytesToHexStr(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** 解析 hex 字符串（支持空格/逗号/冒号分隔或连续 hex，可带 0x 前缀） */
function hexToBytes(input: string): number[] {
  const clean = input.replace(/0x/gi, '').replace(/[\s,;:\-]+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('非法 hex 字节串');
  }
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function bytesToBase64(bytes: number[]): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(input: string): number[] {
  const bin = atob(input.replace(/\s+/g, ''));
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}

// ---------------------------------------------------------------------------
// pronto（0000 raw 与 0100 raw-unmodulated，结构一致）
// ---------------------------------------------------------------------------

function parsePronto(input: string): CanonicalSignal {
  const words = input.trim().split(/\s+/).map((w) => parseInt(w, 16));
  if (words.length < 4 || words.some((w) => Number.isNaN(w))) {
    throw new Error('非法 Pronto hex');
  }
  const type = words[0];
  if (type !== 0x0000 && type !== 0x0100) {
    throw new Error(`不支持的 Pronto 类型 ${words[0].toString(16).padStart(4, '0')}（仅支持 0000/0100）`);
  }
  const freqWord = words[1];
  const period = freqWord * PRONTO_TICK; // µs
  const carrierHz = freqWord > 0 ? Math.round(1_000_000 / period) : DEFAULT_CARRIER;
  const onceLen = words[2] * 2;
  const repeatLen = words[3] * 2;
  const body = words.slice(4);
  if (body.length < onceLen + repeatLen) throw new Error('Pronto hex 长度不足');
  const seq = body.slice(0, onceLen + repeatLen).map((w) => Math.round(w * period));
  return { carrierHz, pulses: seq };
}

function formatPronto(sig: CanonicalSignal): string {
  const carrier = sig.carrierHz > 0 ? sig.carrierHz : DEFAULT_CARRIER;
  const freqWord = Math.max(1, Math.round(1_000_000 / (carrier * PRONTO_TICK)));
  const period = freqWord * PRONTO_TICK;
  let pulses = sig.pulses.slice();
  if (pulses.length % 2 !== 0) pulses = [...pulses, period]; // 补足成对（结尾 space 占位）
  const pairs = pulses.length / 2;
  const words: string[] = [
    '0000',
    freqWord.toString(16).padStart(4, '0').toUpperCase(),
    pairs.toString(16).padStart(4, '0').toUpperCase(),
    '0000',
  ];
  for (const d of pulses) {
    words.push(Math.max(1, Math.round(d / period)).toString(16).padStart(4, '0').toUpperCase());
  }
  return words.join(' ');
}

// ---------------------------------------------------------------------------
// lirc（raw_codes 文本）
// ---------------------------------------------------------------------------

function parseLirc(input: string): CanonicalSignal {
  const m = /begin\s+raw_codes([\s\S]*?)end\s+raw_codes/i.exec(input);
  if (!m) throw new Error('LIRC: 未找到 begin raw_codes 块');
  const freqM = /^\s*frequency\s+(\d+)/im.exec(input);
  const carrierHz = freqM ? parseInt(freqM[1], 10) : DEFAULT_CARRIER;
  // 去掉 name 行，其余数字为脉宽
  const body = m[1].replace(/^\s*name\s+.*$/gim, ' ');
  const pulses = (body.match(/\d+/g) ?? []).map((s) => parseInt(s, 10));
  if (pulses.length < 2) throw new Error('LIRC: raw_codes 为空');
  return { carrierHz, pulses };
}

function formatLirc(sig: CanonicalSignal): string {
  const gap = Math.max(5000, ...sig.pulses.filter((_, i) => i % 2 === 1), 0);
  const lines: string[] = [
    'begin remote',
    '  name  irctl',
    `  flags RAW_CODES`,
    '  eps            30',
    '  aeps           100',
    `  frequency      ${Math.round(sig.carrierHz)}`,
    `  gap            ${Math.round(gap)}`,
    '  begin raw_codes',
    '    name code',
  ];
  // 每行 8 个数值
  for (let i = 0; i < sig.pulses.length; i += 8) {
    lines.push('      ' + sig.pulses.slice(i, i + 8).map((d) => Math.round(d)).join(' '));
  }
  lines.push('  end raw_codes', 'end remote');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// broadlink（0x26 IR 包；hex 与 base64 两种外皮）
// ---------------------------------------------------------------------------

function parseBroadlinkBytes(bytes: number[]): CanonicalSignal {
  if (bytes.length < 4) throw new Error('Broadlink 包过短');
  if (bytes[0] !== 0x26 && bytes[0] !== 0x00) {
    throw new Error(`Broadlink: 不支持的包类型 0x${bytes[0].toString(16)}`);
  }
  const declared = bytes[2] | (bytes[3] << 8);
  const end = Math.min(bytes.length, 4 + declared);
  const pulses: number[] = [];
  let i = 4;
  while (i < end) {
    let v = bytes[i];
    if (v === 0x00) {
      if (i + 2 >= end) break;
      v = (bytes[i + 1] << 8) | bytes[i + 2];
      i += 3;
    } else {
      i += 1;
    }
    pulses.push(Math.round(v * BROADLINK_TICK_US));
  }
  return { carrierHz: DEFAULT_CARRIER, pulses };
}

function formatBroadlinkBytes(sig: CanonicalSignal): number[] {
  const data: number[] = [];
  for (const d of sig.pulses) {
    const v = Math.max(1, Math.round(d / BROADLINK_TICK_US));
    if (v > 0xff) {
      data.push(0x00, (v >> 8) & 0xff, v & 0xff);
    } else {
      data.push(v);
    }
  }
  return [0x26, 0x00, data.length & 0xff, (data.length >> 8) & 0xff, ...data];
}

// ---------------------------------------------------------------------------
// raw / json / xml / module
// ---------------------------------------------------------------------------

function parseRaw(input: string): CanonicalSignal {
  const pulses = input
    .trim()
    .split(/[\s,;]+/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const v = Number(s);
      if (!Number.isFinite(v)) throw new Error(`raw: 非法数值 "${s}"`);
      return v;
    });
  if (pulses.length < 2) throw new Error('raw: 脉宽数量不足');
  return { carrierHz: DEFAULT_CARRIER, pulses };
}

function parseJson(input: string): CanonicalSignal {
  const o = JSON.parse(input) as Record<string, unknown>;
  const pulses = (o.pulses ?? o.durations ?? o.data) as unknown;
  if (!Array.isArray(pulses) || pulses.length < 2) throw new Error('json: 缺少 pulses 数组');
  const carrier = (o.carrierHz ?? o.carrier_hz ?? o.carrier) as number | undefined;
  return { carrierHz: carrier ?? DEFAULT_CARRIER, pulses: pulses.map(Number) };
}

function formatJson(sig: CanonicalSignal): string {
  return JSON.stringify({ carrier_hz: Math.round(sig.carrierHz), pulses: sig.pulses.map(Math.round) });
}

function parseXml(input: string): CanonicalSignal {
  const carrierM = /carrier(?:Hz)?\s*=\s*["'](\d+)["']/i.exec(input);
  const bodyM = /<pulses[^>]*>([\s\S]*?)<\/pulses>/i.exec(input) ?? /<signal[^>]*>([\s\S]*?)<\/signal>/i.exec(input);
  if (!bodyM) throw new Error('xml: 未找到脉宽内容');
  const pulses = (bodyM[1].match(/[\d.]+/g) ?? []).map(Number);
  if (pulses.length < 2) throw new Error('xml: 脉宽数量不足');
  return { carrierHz: carrierM ? parseInt(carrierM[1], 10) : DEFAULT_CARRIER, pulses };
}

function formatXml(sig: CanonicalSignal): string {
  return `<signal carrier="${Math.round(sig.carrierHz)}"><pulses>${sig.pulses.map(Math.round).join(' ')}</pulses></signal>`;
}

/**
 * 模块 blob：[len_hi len_lo][data...][FF FF FF FF]，
 * len 为整个 blob 总字节数；data 每字节 = 一个边沿时长（MODULE_TICK_US 量化，截断 255）。
 */
function parseModule(input: string): CanonicalSignal {
  const bytes = hexToBytes(input);
  if (bytes.length < 7) throw new Error('module: blob 过短');
  const total = (bytes[0] << 8) | bytes[1];
  if (total !== bytes.length) throw new Error(`module: 长度字段 ${total} 与实际 ${bytes.length} 不符`);
  const tail = bytes.slice(-4);
  if (!tail.every((b) => b === 0xff)) throw new Error('module: 缺少 FF FF FF FF 结尾');
  const data = bytes.slice(2, -4);
  return { carrierHz: DEFAULT_CARRIER, pulses: data.map((b) => b * MODULE_TICK_US) };
}

function formatModule(sig: CanonicalSignal): string {
  const data = sig.pulses.map((d) => Math.max(1, Math.min(255, Math.round(d / MODULE_TICK_US))));
  const total = data.length + 6;
  const bytes = [(total >> 8) & 0xff, total & 0xff, ...data, 0xff, 0xff, 0xff, 0xff];
  return bytesToHexStr(bytes);
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

export function parseToCanonical(input: string, from: ConvertFormat): CanonicalSignal {
  const fmt = from === 'auto' ? detectFormat(input) : from;
  switch (fmt) {
    case 'pronto':
      return parsePronto(input);
    case 'lirc':
      return parseLirc(input);
    case 'broadlink_hex':
      return parseBroadlinkBytes(hexToBytes(input));
    case 'broadlink_b64':
      return parseBroadlinkBytes(base64ToBytes(input));
    case 'raw':
      return parseRaw(input);
    case 'json':
      return parseJson(input);
    case 'xml':
      return parseXml(input);
    case 'module':
      return parseModule(input);
    default:
      throw new Error(`parseToCanonical: 不支持的格式 "${fmt}"`);
  }
}

export function formatFromCanonical(sig: CanonicalSignal, to: ConvertFormat): string {
  switch (to) {
    case 'pronto':
      return formatPronto(sig);
    case 'lirc':
      return formatLirc(sig);
    case 'broadlink_hex':
      return bytesToHexStr(formatBroadlinkBytes(sig));
    case 'broadlink_b64':
      return bytesToBase64(formatBroadlinkBytes(sig));
    case 'raw':
      return sig.pulses.map((d) => Math.round(d)).join(', ');
    case 'json':
      return formatJson(sig);
    case 'xml':
      return formatXml(sig);
    case 'module':
      return formatModule(sig);
    default:
      throw new Error(`formatFromCanonical: 不支持的格式 "${to}"`);
  }
}

/** 管线式转换：input(from) → CanonicalSignal → (to) */
export function convert(input: string, from: ConvertFormat, to: ConvertFormat): string {
  return formatFromCanonical(parseToCanonical(input, from), to);
}

/** 自动识别输入格式 */
export function detectFormat(input: string): ConvertFormat {
  const s = input.trim();
  if (!s) throw new Error('detectFormat: 空输入');

  if (s[0] === '{') return 'json';
  if (s[0] === '<') return 'xml';
  if (/begin\s+(remote|raw_codes)/i.test(s)) return 'lirc';

  // Pronto：全部 token 为 4 位 hex，首字 0000/0100
  const tokens = s.split(/\s+/);
  if (
    tokens.length >= 4 &&
    /^(0000|0100)$/i.test(tokens[0]) &&
    tokens.every((t) => /^[0-9a-fA-F]{4}$/.test(t))
  ) {
    return 'pronto';
  }

  // hex 字节串：模块 blob 或 broadlink hex
  const hexClean = s.replace(/0x/gi, '').replace(/[\s,;:\-]+/g, '');
  if (/^[0-9a-fA-F]+$/.test(hexClean) && hexClean.length % 2 === 0 && hexClean.length >= 12) {
    const bytes: number[] = [];
    for (let i = 0; i < hexClean.length; i += 2) bytes.push(parseInt(hexClean.slice(i, i + 2), 16));
    if (bytes[0] === 0x26) return 'broadlink_hex';
    const total = (bytes[0] << 8) | bytes[1];
    if (total === bytes.length && bytes.slice(-4).every((b) => b === 0xff)) return 'module';
  }

  // Broadlink base64（0x26 开头）
  if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.replace(/\s+/g, '').length % 4 === 0) {
    try {
      const bytes = base64ToBytes(s);
      if (bytes.length >= 4 && bytes[0] === 0x26) return 'broadlink_b64';
    } catch {
      /* 非 base64 */
    }
  }

  // raw µs 数组
  if (/^[\d\s,.;]+$/.test(s) && /\d/.test(s)) return 'raw';

  throw new Error('detectFormat: 无法识别的格式');
}
