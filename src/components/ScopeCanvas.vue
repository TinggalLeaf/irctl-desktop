<script setup lang="ts">
/**
 * 脉宽示波器：mark 高 / space 低方波 + 时间轴。
 * 交互：滚轮以鼠标为中心缩放、按住拖动平移、双击复位、双游标拖动测距（Δt）。
 * DPR 自适应；颜色全部取自 Element Plus CSS 变量，暗亮主题自动跟随。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';
import type { PulseTrain } from '../types/ir';

defineOptions({ name: 'ScopeCanvas' });

const props = defineProps<{ train: PulseTrain | null }>();
/** 游标位置（µs 绝对时间，null = 关闭） */
const cursorA = defineModel<number | null>('cursorA', { default: null });
const cursorB = defineModel<number | null>('cursorB', { default: null });

/** 判定为 burst 边界的 space 时长（µs） */
const BURST_GAP_US = 10000;
/** 缩放最小窗口（µs） */
const MIN_SPAN_US = 20;

const wrapEl = ref<HTMLDivElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);

/** 可见时间窗口（µs） */
const view = ref({ start: 0, end: 1 });

let totalUs = 0;
/** 各脉冲结束时刻（edges[0] = 0 为首脉冲起点） */
let edges: number[] = [];
/** burst 边界时刻 */
let bursts: number[] = [];

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let rafId = 0;

type DragMode = 'none' | 'pan' | 'cursorA' | 'cursorB';
let drag: DragMode = 'none';
let lastX = 0;

function rebuild() {
  edges = [];
  bursts = [];
  const t = props.train;
  if (!t || t.pulses.length === 0) {
    totalUs = 0;
    return;
  }
  let acc = 0;
  edges.push(0);
  for (let i = 0; i < t.pulses.length; i++) {
    acc += t.pulses[i];
    edges.push(acc);
    if (i % 2 === 1 && t.pulses[i] >= BURST_GAP_US) bursts.push(acc);
  }
  totalUs = acc;
}

function resetView() {
  view.value = { start: 0, end: Math.max(1, totalUs) };
}

defineExpose({ resetView });

interface Metrics {
  W: number;
  H: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
  plotW: number;
  plotH: number;
}

function metrics(): Metrics {
  const c = canvasEl.value;
  const W = c?.clientWidth ?? 0;
  const H = c?.clientHeight ?? 0;
  const padL = 8;
  const padR = 8;
  const padT = 26;
  const padB = 22;
  return {
    W,
    H,
    padL,
    padR,
    padT,
    padB,
    plotW: Math.max(1, W - padL - padR),
    plotH: Math.max(1, H - padT - padB),
  };
}

function timeAtX(px: number): number {
  const m = metrics();
  const span = view.value.end - view.value.start;
  return view.value.start + ((px - m.padL) / m.plotW) * span;
}

function xAtTime(t: number): number {
  const m = metrics();
  const span = view.value.end - view.value.start;
  return m.padL + ((t - view.value.start) / span) * m.plotW;
}

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

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const r = raw / p;
  if (r < 1.5) return p;
  if (r < 3.5) return 2 * p;
  if (r < 7.5) return 5 * p;
  return 10 * p;
}

function fmtUs(t: number): string {
  return t >= 1000 ? `${(t / 1000).toFixed(2)}ms` : `${Math.round(t)}µs`;
}

function draw() {
  const c = canvasEl.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const m = metrics();
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(m.W * dpr) || c.height !== Math.round(m.H * dpr)) {
    c.width = Math.round(m.W * dpr);
    c.height = Math.round(m.H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, m.W, m.H);

  const cWave = cssVar('--el-color-primary', '#3a86ff');
  const cText = cssVar('--el-text-color-secondary', '#909399');
  const cGrid = cssVar('--el-border-color-lighter', '#e4e7ed');
  const cBurst = cssVar('--el-color-warning', '#e6a23c');
  const cCurA = cssVar('--el-color-danger', '#f56c6c');
  const cCurB = cssVar('--el-color-success', '#67c23a');

  if (!props.train || edges.length < 2 || totalUs <= 0) {
    ctx.fillStyle = cText;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('暂无波形数据 —— 点击「开始学习」捕获红外信号', m.W / 2, m.H / 2);
    return;
  }

  const highY = m.padT + m.plotH * 0.18;
  const lowY = m.padT + m.plotH * 0.82;
  const span = view.value.end - view.value.start;

  // ---------- 时间轴网格与刻度 ----------
  ctx.lineWidth = 1;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const step = niceStep(span / 8);
  const t0 = Math.ceil(view.value.start / step) * step;
  ctx.strokeStyle = cGrid;
  ctx.fillStyle = cText;
  ctx.beginPath();
  for (let t = t0; t <= view.value.end + 1e-9; t += step) {
    const x = Math.round(xAtTime(t)) + 0.5;
    ctx.moveTo(x, m.padT);
    ctx.lineTo(x, m.padT + m.plotH);
    ctx.fillText(fmtUs(t), x, m.H - 6);
  }
  ctx.stroke();

  // 基线
  ctx.beginPath();
  ctx.moveTo(m.padL, lowY + 0.5);
  ctx.lineTo(m.W - m.padR, lowY + 0.5);
  ctx.stroke();

  // ---------- burst 边界（长 space 结尾） ----------
  ctx.strokeStyle = cBurst;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const t of bursts) {
    if (t < view.value.start || t > view.value.end) continue;
    const x = Math.round(xAtTime(t)) + 0.5;
    ctx.moveTo(x, m.padT);
    ctx.lineTo(x, m.padT + m.plotH);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // ---------- 波形 ----------
  ctx.strokeStyle = cWave;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const startT = Math.max(0, view.value.start);
  // 找起点所在脉冲下标，确定起始电平
  let idx = 0;
  while (idx < edges.length - 1 && edges[idx + 1] <= startT) idx++;
  let y = idx % 2 === 0 ? highY : lowY;
  ctx.moveTo(xAtTime(startT), y);
  for (let i = idx + 1; i < edges.length; i++) {
    const t = edges[i];
    if (t > view.value.end) break;
    const x = xAtTime(t);
    ctx.lineTo(x, y); // 水平到边沿
    y = i % 2 === 0 ? highY : lowY; // 进入 pulse i 的电平
    ctx.lineTo(x, y); // 垂直跳变
  }
  ctx.lineTo(xAtTime(Math.min(view.value.end, totalUs)), y);
  ctx.stroke();

  // ---------- 游标 ----------
  const drawCursor = (t: number, color: string, label: string) => {
    const x = Math.round(xAtTime(t)) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, m.padT + m.plotH);
    ctx.stroke();
    // 手柄三角
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5, 4);
    ctx.lineTo(x + 5, 4);
    ctx.lineTo(x, 12);
    ctx.closePath();
    ctx.fill();
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${label} ${fmtUs(t)}`, Math.min(x + 6, m.W - 90), 11);
  };
  if (cursorA.value != null) drawCursor(cursorA.value, cCurA, 'A');
  if (cursorB.value != null) drawCursor(cursorB.value, cCurB, 'B');
  if (cursorA.value != null && cursorB.value != null) {
    ctx.fillStyle = cText;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Δt = ${fmtUs(Math.abs(cursorB.value - cursorA.value))}`, m.W / 2, 11);
  }
}

// ---------- 交互 ----------
function onWheel(e: WheelEvent) {
  if (!props.train || totalUs <= 0) return;
  e.preventDefault();
  const c = canvasEl.value;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const t = timeAtX(e.clientX - rect.left);
  const span = view.value.end - view.value.start;
  const factor = e.deltaY > 0 ? 1.25 : 0.8;
  const ns = Math.min(Math.max(MIN_SPAN_US, span * factor), Math.max(totalUs, MIN_SPAN_US));
  const ratio = span > 0 ? (t - view.value.start) / span : 0.5;
  let start = t - ns * ratio;
  start = Math.max(0, Math.min(Math.max(0, totalUs - ns), start));
  view.value = { start, end: start + ns };
}

function onPointerDown(e: PointerEvent) {
  const c = canvasEl.value;
  if (!c || !props.train || totalUs <= 0) return;
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  lastX = x;
  const hit = (t: number | null) => t != null && Math.abs(xAtTime(t) - x) <= 8;
  if (hit(cursorA.value)) drag = 'cursorA';
  else if (hit(cursorB.value)) drag = 'cursorB';
  else drag = 'pan';
  c.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (drag === 'none') return;
  const c = canvasEl.value;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (drag === 'pan') {
    const m = metrics();
    const span = view.value.end - view.value.start;
    const dt = ((lastX - x) / m.plotW) * span;
    let start = view.value.start + dt;
    start = Math.max(0, Math.min(Math.max(0, totalUs - span), start));
    view.value = { start, end: start + span };
  } else {
    const t = Math.max(0, Math.min(totalUs, timeAtX(x)));
    if (drag === 'cursorA') cursorA.value = t;
    else cursorB.value = t;
  }
  lastX = x;
}

function onPointerUp() {
  drag = 'none';
}

function onDblClick() {
  resetView();
}

function toggleCursor(which: 'A' | 'B') {
  const model = which === 'A' ? cursorA : cursorB;
  if (model.value != null) {
    model.value = null;
    return;
  }
  const span = view.value.end - view.value.start;
  model.value = view.value.start + span * (which === 'A' ? 1 / 3 : 2 / 3);
}

// ---------- 生命周期 ----------
watch(
  () => props.train,
  () => {
    rebuild();
    resetView();
    cursorA.value = null;
    cursorB.value = null;
    scheduleDraw();
  },
  { deep: true },
);
watch([view, cursorA, cursorB], () => scheduleDraw());

onMounted(() => {
  rebuild();
  resetView();
  if (wrapEl.value) {
    ro = new ResizeObserver(scheduleDraw);
    ro.observe(wrapEl.value);
  }
  // 主题切换（html class 变化）时重绘以取新颜色
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
  <div ref="wrapEl" class="scope-canvas">
    <canvas
      ref="canvasEl"
      class="scope-canvas__el"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @dblclick="onDblClick"
    />
    <div class="scope-toolbar">
      <el-button
        size="small"
        :type="cursorA != null ? 'danger' : 'default'"
        :disabled="!train"
        @click="toggleCursor('A')"
      >游标 A</el-button>
      <el-button
        size="small"
        :type="cursorB != null ? 'success' : 'default'"
        :disabled="!train"
        @click="toggleCursor('B')"
      >游标 B</el-button>
      <el-button size="small" :disabled="!train" @click="resetView">复位视图</el-button>
    </div>
  </div>
</template>

<style scoped lang="scss">
.scope-canvas {
  position: relative;
  width: 100%;
  height: 340px;
}

.scope-canvas__el {
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
  touch-action: none;

  &:active {
    cursor: grabbing;
  }
}

.scope-toolbar {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  gap: 8px;
}
</style>
