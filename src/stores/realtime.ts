/**
 * 实时捕获 store：EB 学习循环是模块唯一的"信号上送"通道（学习中模块只认 E2），
 * 因此实时页与学习页（软件模式）共用本 store 作为 EB 唯一所有者，避免并发学习冲突。
 * 每捕获一帧立即重发 EB 重新武装，形成连续捕获；所有样本不做频段/协议过滤。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { hw, onIrEvent, type IrEventPayload } from '../lib/hardware';
import { parseToCanonical } from '../lib/convert';
import { decodeFrames, estimateCarrier } from '../lib/protocol';
import { useSettingsStore } from './settings';

export interface RtSample {
  id: number;
  /** 捕获时间戳 ms */
  ts: number;
  blob: number[];
  pulses: number[];
  /** 估计载波 Hz（不过滤，可能落在 30-56kHz 之外） */
  carrierHz: number;
  /** 识别出的协议名，未识别为 '未知' */
  protocol: string;
  address?: number;
  command?: number;
  pulseCount: number;
  durationUs: number;
  minPulseUs: number;
  maxPulseUs: number;
  hex: string;
}

const MAX_SAMPLES = 2000;

function bytesToHex(b: number[]): string {
  return b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export const useRealtimeStore = defineStore('realtime', () => {
  const capturing = ref(false);
  const samples = ref<RtSample[]>([]);
  const lastError = ref('');
  let seq = 0;
  let unlisten: (() => void) | null = null;
  /** 防止 start 重入（学习页与实时页可能同时触发） */
  let starting = false;

  function blobToSample(blob: number[]): RtSample {
    const hex = bytesToHex(blob);
    const sig = parseToCanonical(hex, 'module');
    const train = { carrierHz: sig.carrierHz, pulses: sig.pulses };
    const settings = useSettingsStore();
    const dec = decodeFrames(train, {
      tolerance: settings.receive.tolerance / 100,
      glitchFilterUs: settings.receive.glitchFilterUs,
    })[0];
    const pulses = sig.pulses;
    return {
      id: ++seq,
      ts: Date.now(),
      blob: [...blob],
      pulses,
      carrierHz: estimateCarrier(train),
      protocol: dec?.protocol ?? '未知',
      address: dec?.address,
      command: dec?.command,
      pulseCount: pulses.length,
      durationUs: pulses.reduce((a, b) => a + b, 0),
      minPulseUs: pulses.length ? Math.min(...pulses) : 0,
      maxPulseUs: pulses.length ? Math.max(...pulses) : 0,
      hex,
    };
  }

  function pushSample(sample: RtSample) {
    samples.value.push(sample);
    if (samples.value.length > MAX_SAMPLES) {
      samples.value.splice(0, samples.value.length - MAX_SAMPLES);
    }
  }

  /** 重新武装 EB 学习（捕获一帧后 / 超时错误后） */
  async function rearm() {
    try {
      await hw.learnStart();
    } catch (e) {
      lastError.value = typeof e === 'string' ? e : (e as Error)?.message ?? '重新进入学习失败';
      capturing.value = false;
    }
  }

  function onEvent(p: IrEventPayload) {
    if (!capturing.value) return;
    if (p.kind === 'learned' && p.blob) {
      try {
        pushSample(blobToSample(p.blob));
      } catch (e) {
        lastError.value = `样本解析失败：${typeof e === 'string' ? e : (e as Error)?.message}`;
      }
      if (capturing.value) void rearm();
    } else if (p.kind === 'error') {
      lastError.value = p.message ?? '模块返回错误';
      // 学习超时（Rust 侧已自动发 E2 取消）后重新武装，保持连续捕获
      if (capturing.value) void rearm();
    }
  }

  async function ensureListener() {
    if (!unlisten) {
      unlisten = await onIrEvent(onEvent);
    }
  }

  /** 开始连续捕获；已在使用方之间幂等 */
  async function start(): Promise<void> {
    if (capturing.value || starting) return;
    starting = true;
    try {
      await ensureListener();
      await hw.learnStart();
      capturing.value = true;
      lastError.value = '';
    } catch (e) {
      lastError.value = typeof e === 'string' ? e : (e as Error)?.message ?? '启动捕获失败';
      throw e;
    } finally {
      starting = false;
    }
  }

  async function stop(): Promise<void> {
    capturing.value = false;
    try {
      await hw.learnCancel();
    } catch {
      /* 取消失败也复位状态 */
    }
  }

  /** 清空全部样本（捕获状态不变，调用方可随后重新 start 实现"清空重捕"） */
  function clear() {
    samples.value = [];
    seq = 0;
    lastError.value = '';
  }

  // ---------- 统计 ----------
  const totalCount = computed(() => samples.value.length);
  const latest = computed(() => samples.value[samples.value.length - 1] ?? null);
  /** 平均捕获速率（次/分钟），按首尾样本时间窗估算 */
  const ratePerMin = computed(() => {
    const s = samples.value;
    if (s.length < 2) return 0;
    const spanMs = s[s.length - 1].ts - s[0].ts;
    if (spanMs <= 0) return 0;
    return Math.round(((s.length - 1) / spanMs) * 60000);
  });

  return {
    capturing,
    samples,
    lastError,
    start,
    stop,
    clear,
    totalCount,
    latest,
    ratePerMin,
  };
});
