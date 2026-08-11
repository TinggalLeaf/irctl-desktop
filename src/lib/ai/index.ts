/**
 * AI 模块：OpenAI 兼容流式对话 client + 10 个本地红外工具（function calling）
 *
 * - streamChat：POST {baseUrl}/chat/completions（stream:true），SSE 逐行解析，
 *   支持 tool_calls 增量聚合
 * - AI_TOOLS：ARCHITECTURE.md 规定的 10 个本地工具定义
 * - executeTool：本地执行器，协议编解码/逆向分析调本前端 protocol/convert 库
 */
import type { AiToolDef, ConvertFormat, DecodedFrame, PulseTrain } from '../../types/ir';
import { decodeFrames, encodeFrame } from '../protocol';
import { convert } from '../convert';

/* ================= OpenAI 兼容流式对话 ================= */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: AggregatedToolCall[];
}

/** 增量聚合后的完整工具调用 */
export interface AggregatedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON 字符串（流式聚合完成后的完整 arguments） */
    arguments: string;
  };
}

export interface StreamChatResult {
  content: string;
  toolCalls: AggregatedToolCall[];
}

export interface StreamChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** 本地工具定义（缺省用 AI_TOOLS） */
  tools?: AiToolDef[];
  /** 每收到一段文本增量回调 */
  onDelta?: (text: string) => void;
  /** 流正常结束回调 */
  onDone?: (result: StreamChatResult) => void;
  /** 出错回调（Promise 同时 reject） */
  onError?: (err: Error) => void;
  /** 外部中止 */
  signal?: AbortSignal;
}

/** AiToolDef → OpenAI tools 参数格式 */
function toOpenAiTools(tools: AiToolDef[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** SSE delta 里的 tool_calls 增量聚合（按 index 归并，arguments 字符串拼接） */
function mergeToolCallDelta(
  acc: AggregatedToolCall[],
  deltas: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const d of deltas) {
    const idx = d.index ?? acc.length;
    while (acc.length <= idx) {
      acc.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
    }
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

/**
 * OpenAI 兼容流式对话。POST {baseUrl}/chat/completions，stream:true。
 * 返回完整聚合结果；增量文本走 onDelta，结束走 onDone，错误走 onError 并 reject。
 */
export async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
  const { baseUrl, apiKey, model, messages, tools = AI_TOOLS, onDelta, onDone, onError, signal } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const run = async (): Promise<StreamChatResult> => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
      }),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`chat/completions HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }
    if (!resp.body) throw new Error('响应无 body（不支持流式？）');

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls: AggregatedToolCall[] = [];
    let done = false;

    const handleLine = (line: string): void => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') {
        done = true;
        return;
      }
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return; // 忽略坏行（心跳/注释）
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (delta.tool_calls) mergeToolCallDelta(toolCalls, delta.tool_calls);
    };

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line.trimEnd());
    }
    if (buffer) handleLine(buffer.trimEnd()); // 收尾残余

    return { content, toolCalls: toolCalls.filter((t) => t.function.name) };
  };

  try {
    const result = await run();
    onDone?.(result);
    return result;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    onError?.(e);
    throw e;
  }
}

/* ================= 10 个本地工具定义 ================= */

export const AI_TOOLS: AiToolDef[] = [
  {
    name: 'nec_encode',
    description: '用 NEC/NECext 协议编码一帧红外码，返回 µs 脉宽时间线（JSON）',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'number', description: '设备地址（NECext 16bit，如 0x0707）' },
        command: { type: 'number', description: '命令码（8bit）' },
        variant: { type: 'string', description: '可选变体，如 NECext', enum: ['NEC', 'NECext'] },
      },
      required: ['address', 'command'],
    },
  },
  {
    name: 'sirc_encode',
    description: '用 Sony SIRC（12/15/20bit）协议编码一帧红外码',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'number', description: '设备地址（TV=1 等）' },
        command: { type: 'number', description: '命令码（7bit）' },
        variant: { type: 'string', enum: ['SIRC-12', 'SIRC-15', 'SIRC-20'] },
      },
      required: ['address', 'command'],
    },
  },
  {
    name: 'rc5_encode',
    description: '用 Philips RC5 协议编码一帧红外码',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'number', description: '5bit 系统地址（TV=0）' },
        command: { type: 'number', description: '6bit 命令码' },
      },
      required: ['address', 'command'],
    },
  },
  {
    name: 'pronto_to_raw',
    description: 'Pronto Hex（0000/0100）转 µs 脉宽数组',
    parameters: {
      type: 'object',
      properties: {
        pronto: { type: 'string', description: 'Pronto Hex 字符串' },
      },
      required: ['pronto'],
    },
  },
  {
    name: 'raw_to_pronto',
    description: 'µs 脉宽数组转 Pronto Hex',
    parameters: {
      type: 'object',
      properties: {
        raw: { type: 'string', description: '逗号/空格分隔的 µs 脉宽数组' },
        carrier_hz: { type: 'number', description: '载波 Hz，默认 38000' },
      },
      required: ['raw'],
    },
  },
  {
    name: 'broadlink_decode',
    description: 'Broadlink 码（hex 或 base64，0x26/0x00 包）解码为 µs 脉宽数组',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Broadlink hex 或 base64 字符串' },
      },
      required: ['data'],
    },
  },
  {
    name: 'module_blob_to_raw',
    description: '本模块串口学习的私有 blob（hex）解包为 µs 脉宽数组',
    parameters: {
      type: 'object',
      properties: {
        hex: { type: 'string', description: 'blob 的 hex 字符串' },
      },
      required: ['hex'],
    },
  },
  {
    name: 'protocol_identify',
    description: '协议逆向：对一段 µs 脉宽做 17 协议自动识别，返回协议名/地址/命令/置信度',
    parameters: {
      type: 'object',
      properties: {
        pulses: { type: 'array', items: { type: 'number' }, description: 'µs 脉宽数组（mark 起交替）' },
        carrier_hz: { type: 'number', description: '载波 Hz，默认 38000' },
      },
      required: ['pulses'],
    },
  },
  {
    name: 'pulse_measure',
    description: '脉冲参数测量：帧数、总时长、mark/space 统计、去重电平表',
    parameters: {
      type: 'object',
      properties: {
        pulses: { type: 'array', items: { type: 'number' }, description: 'µs 脉宽数组（mark 起交替）' },
      },
      required: ['pulses'],
    },
  },
  {
    name: 'carrier_estimate',
    description: '载波频率估计：基于协议识别置信度与 mark 时长的 30-56kHz 载波估计',
    parameters: {
      type: 'object',
      properties: {
        pulses: { type: 'array', items: { type: 'number' }, description: 'µs 脉宽数组（mark 起交替）' },
      },
      required: ['pulses'],
    },
  },
];

/* ================= 本地工具执行器 ================= */

type ToolArgs = Record<string, unknown>;

function num(v: unknown, name: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || Number.isNaN(n)) throw new Error(`参数 ${name} 必须是数字`);
  return n;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${name} 必须是非空字符串`);
  return v.trim();
}

function pulsesOf(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((x) => Number(x)).filter((x) => !Number.isNaN(x));
  if (typeof v === 'string') {
    return v
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((x) => Number(x))
      .filter((x) => !Number.isNaN(x));
  }
  throw new Error('参数 pulses/raw 必须是数字数组或分隔字符串');
}

/** 编码结果摘要（结构化 JSON 文本） */
function summarizeTrain(protocol: string, train: PulseTrain): string {
  return JSON.stringify({
    protocol,
    carrierHz: train.carrierHz,
    pulseCount: train.pulses.length,
    totalUs: train.pulses.reduce((a, b) => a + b, 0),
    pulses: train.pulses,
  });
}

function summarizeFrames(frames: DecodedFrame[]): string {
  return JSON.stringify(
    frames.map((f) => ({
      protocol: f.protocol,
      protocolVariant: f.protocolVariant,
      address: f.address,
      command: f.command,
      extra: f.extra,
      confidence: f.confidence,
      carrierHz: f.carrierHz,
      rawLength: f.raw.length,
    })),
  );
}

/**
 * 本地执行 AI 工具，返回结构化 JSON 文本（可直接回灌 tool message）。
 * 未知工具/参数错误返回 { error: ... } 文本而不抛异常，方便模型自愈。
 */
export async function executeTool(name: string, args: ToolArgs): Promise<string> {
  try {
    switch (name) {
      case 'nec_encode': {
        const variant = typeof args.variant === 'string' ? args.variant : undefined;
        const train = encodeFrame(variant === 'NECext' ? 'NECext' : 'NEC', num(args.address, 'address'), num(args.command, 'command'));
        return summarizeTrain('NEC', train);
      }
      case 'sirc_encode': {
        const variant = typeof args.variant === 'string' ? args.variant : 'SIRC-12';
        const train = encodeFrame('SONY', num(args.address, 'address'), num(args.command, 'command'), { variant });
        return summarizeTrain(variant, train);
      }
      case 'rc5_encode': {
        const train = encodeFrame('RC5', num(args.address, 'address'), num(args.command, 'command'));
        return summarizeTrain('RC5', train);
      }
      case 'pronto_to_raw':
        return convert(str(args.pronto, 'pronto'), 'pronto', 'raw');
      case 'raw_to_pronto': {
        const raw = typeof args.raw === 'string' ? args.raw : pulsesOf(args.raw).join(',');
        return convert(raw, 'raw', 'pronto');
      }
      case 'broadlink_decode': {
        const data = str(args.data, 'data');
        const from: ConvertFormat = /^[0-9a-fA-F\s]+$/.test(data) ? 'broadlink_hex' : 'broadlink_b64';
        return convert(data, from, 'raw');
      }
      case 'module_blob_to_raw':
        return convert(str(args.hex, 'hex'), 'module', 'raw');
      case 'protocol_identify': {
        const train: PulseTrain = {
          carrierHz: typeof args.carrier_hz === 'number' ? args.carrier_hz : 38000,
          pulses: pulsesOf(args.pulses),
        };
        return summarizeFrames(decodeFrames(train));
      }
      case 'pulse_measure': {
        const pulses = pulsesOf(args.pulses);
        const marks = pulses.filter((_, i) => i % 2 === 0);
        const spaces = pulses.filter((_, i) => i % 2 === 1);
        const stats = (xs: number[]) =>
          xs.length
            ? {
                count: xs.length,
                min: Math.min(...xs),
                max: Math.max(...xs),
                mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length),
              }
            : null;
        const distinct = [...new Set(pulses.map((p) => Math.round(p / 50) * 50))].sort((a, b) => a - b);
        return JSON.stringify({
          pulseCount: pulses.length,
          totalUs: pulses.reduce((a, b) => a + b, 0),
          marks: stats(marks),
          spaces: stats(spaces),
          distinctLevels50us: distinct,
        });
      }
      case 'carrier_estimate': {
        const pulses = pulsesOf(args.pulses);
        const frames = decodeFrames({ carrierHz: 38000, pulses });
        const best = frames.slice().sort((a, b) => b.confidence - a.confidence)[0];
        return JSON.stringify({
          carrierHz: best?.carrierHz ?? 38000,
          method: best ? 'protocol-fit' : 'default-38k',
          confidence: best?.confidence ?? 0,
          protocol: best?.protocol,
        });
      }
      default:
        return JSON.stringify({ error: `未知工具: ${name}`, available: AI_TOOLS.map((t) => t.name) });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), tool: name });
  }
}
