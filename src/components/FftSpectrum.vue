<script setup lang="ts">
/**
 * 载波频谱（30-56kHz）：carrierSpectrum 包络频谱柱状图，标注峰值频率。
 * Canvas 绘制，DPR 自适应，颜色取自 Element Plus CSS 变量。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { carrierSpectrum, type SpectrumPoint } from '../lib/fft';
import type { PulseTrain } from '../types/ir';

defineOptions({ name: 'FftSpectrum' });

const props = defineProps<{ train: PulseTrain | null }>();

const LO_HZ = 30000;
const HI_HZ = 56000;

const spectrum = computed<SpectrumPoint[]>(() =>
  props.train ? carrierSpectrum(props.train, LO_HZ, HI_HZ) : [],
);

const peak = computed<SpectrumPoint | null>(() => {
  let best: SpectrumPoint | null = null;
  for (const p of spectrum.value) {
    if (!best || p.magnitude > best.magnitude) best = p;
  }
  return best;
});

const peakText = computed(() =>
  peak.value && peak.value.magnitude > 0 ? `${(peak.value.freq / 1000).toFixed(2)} kHz` : '—',
);

const wrapEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let rafId = 0;

function cssVar(name: string, fallback: string): string {
  const el = canvasEl.value;
  if (!el) return fallback;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function scheduleDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    draw();
  });
}

function draw() {
  const c = canvasEl.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.clientWidth;
  const H = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cBar = cssVar('--el-color-primary-light-5', '#a0cfff');
  const cPeak = cssVar('--el-color-danger', '#f56c6c');
  const cText = cssVar('--el-text-color-secondary', '#909399');
  const cGrid = cssVar('--el-border-color-lighter', '#e4e7ed');

  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 20;
  const plotW = Math.max(1, W - padL - padR);
  const plotH = Math.max(1, H - padT - padB);

  const pts = spectrum.value;
  if (pts.length === 0) {
    ctx.fillStyle = cText;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('暂无频谱数据', W / 2, H / 2);
    return;
  }

  // x 轴刻度（30/35/40/45/50/55 kHz）与网格
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineWidth = 1;
  ctx.strokeStyle = cGrid;
  ctx.fillStyle = cText;
  ctx.beginPath();
  for (let f = LO_HZ; f < HI_HZ; f += 5000) {
    const x = Math.round(padL + ((f - LO_HZ) / (HI_HZ - LO_HZ)) * plotW) + 0.5;
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.fillText(`${f / 1000}`, x, H - 5);
  }
  ctx.stroke();
  // 基线
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH + 0.5);
  ctx.lineTo(W - padR, padT + plotH + 0.5);
  ctx.stroke();

  const maxMag = Math.max(...pts.map((p) => p.magnitude), 1e-9);
  const barW = plotW / pts.length;
  const pk = peak.value;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const h = (p.magnitude / maxMag) * plotH;
    const x = padL + i * barW;
    ctx.fillStyle = pk && p.freq === pk.freq && p.magnitude === pk.magnitude ? cPeak : cBar;
    ctx.fillRect(x, padT + plotH - h, Math.max(1, barW - 1), h);
  }

  // 峰值标注
  if (pk && pk.magnitude > 0) {
    const i = pts.indexOf(pk);
    const x = padL + i * barW + barW / 2;
    const h = (pk.magnitude / maxMag) * plotH;
    ctx.fillStyle = cPeak;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(peakText.value, Math.max(34, Math.min(W - 34, x)), Math.max(11, padT + plotH - h - 4));
  }
}

watch(spectrum, scheduleDraw);

onMounted(() => {
  if (wrapEl.value) {
    ro = new ResizeObserver(scheduleDraw);
    ro.observe(wrapEl.value);
  }
  mo = new MutationObserver(scheduleDraw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  scheduleDraw();
});

onUnmounted(() => {
  ro?.disconnect();
  mo?.disconnect();
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <div ref="wrapEl" class="fft-spectrum">
    <canvas ref="canvasEl" class="fft-spectrum__el" />
    <div class="fft-peak text-secondary">
      峰值 <span class="mono peak-val">{{ peakText }}</span>
    </div>
  </div>
</template>

<style scoped lang="scss">
.fft-spectrum {
  position: relative;
  width: 100%;
  height: 200px;
}

.fft-spectrum__el {
  width: 100%;
  height: 100%;
  display: block;
}

.fft-peak {
  position: absolute;
  top: 0;
  right: 0;
  font-size: 12px;

  .peak-val {
    color: var(--el-color-danger);
    font-weight: 600;
  }
}
</style>
