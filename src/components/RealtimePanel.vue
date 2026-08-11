<script setup lang="ts">
/**
 * 实时捕获图表面板（股票式大图）：
 * 1. 主图：载波频段折线 + 脉冲数量柱（股价/成交量式双格联动，dataZoom 缩放/滑窗）
 * 2. 最新帧波形：µs 级阶梯折线，dataZoom 细看每个脉冲
 * 3. 脉冲时长直方图 + 协议分布饼图
 * 所有样本逐帧绘制，不做聚合/过滤。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { RtSample } from '../stores/realtime';

defineOptions({ name: 'RealtimePanel' });

const props = defineProps<{ samples: RtSample[] }>();

const stockEl = ref<HTMLDivElement>();
const waveEl = ref<HTMLDivElement>();
const histEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();

let stock: echarts.ECharts | null = null;
let wave: echarts.ECharts | null = null;
let hist: echarts.ECharts | null = null;
let pie: echarts.ECharts | null = null;

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function primary(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary').trim() ||
    '#3a86ff'
  );
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function renderStock() {
  if (!stock) return;
  const s = props.samples;
  const dark = isDark();
  const text = { color: dark ? '#aab3c0' : '#606266', fontSize: 11 };
  const line = dark ? '#4c5260' : '#dcdfe6';
  const split = dark ? '#232833' : '#f2f4f8';
  const pc = primary();

  stock.setOption(
    {
      animation: false,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { show: true, fontSize: 10 } },
      },
      axisLabel: text,
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], zoomOnMouseWheel: true, moveOnMouseMove: true },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          height: 22,
          bottom: 6,
          borderColor: line,
          textStyle: text,
        },
      ],
      grid: [
        { left: 56, right: 20, top: 34, height: '52%' },
        { left: 56, right: 20, top: '66%', height: '16%' },
      ],
      xAxis: [
        {
          type: 'category',
          data: s.map((x) => timeLabel(x.ts)),
          gridIndex: 0,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: line } },
        },
        {
          type: 'category',
          data: s.map((x) => timeLabel(x.ts)),
          gridIndex: 1,
          axisLabel: { ...text, hideOverlap: true },
          axisLine: { lineStyle: { color: line } },
        },
      ],
      yAxis: [
        {
          type: 'value',
          name: '载波 kHz',
          gridIndex: 0,
          min: 20,
          max: 65,
          axisLabel: text,
          axisLine: { lineStyle: { color: line } },
          splitLine: { lineStyle: { color: split } },
        },
        {
          type: 'value',
          name: '脉冲数',
          gridIndex: 1,
          axisLabel: text,
          axisLine: { lineStyle: { color: line } },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '载波',
          type: 'line',
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: s.map((x) => +(x.carrierHz / 1000).toFixed(2)),
          showSymbol: false,
          smooth: 0.2,
          lineStyle: { width: 1.6, color: pc },
          itemStyle: { color: pc },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: pc + '55' },
                { offset: 1, color: pc + '05' },
              ],
            },
          },
          markArea: {
            silent: true,
            itemStyle: { color: dark ? 'rgba(120,150,255,0.07)' : 'rgba(58,134,255,0.07)' },
            label: { ...text, position: 'insideTopRight' },
            data: [[{ name: '30-56kHz', yAxis: 30 }, { yAxis: 56 }]],
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { type: 'dashed', color: '#e6a23c', width: 1 },
            label: { ...text, formatter: '38k' },
            data: [{ yAxis: 38 }],
          },
        },
        {
          name: '脉冲数',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: s.map((x) => x.pulseCount),
          itemStyle: { color: pc + 'aa' },
          barMaxWidth: 8,
        },
      ],
    },
    { notMerge: true },
  );
}

function renderWave() {
  if (!wave) return;
  const dark = isDark();
  const text = { color: dark ? '#aab3c0' : '#606266', fontSize: 11 };
  const line = dark ? '#4c5260' : '#dcdfe6';
  const split = dark ? '#232833' : '#f2f4f8';
  const latest = props.samples[props.samples.length - 1];

  // 阶梯波形：mark=高电平 / space=低电平，x 轴为累计 µs
  const data: [number, number][] = [];
  let acc = 0;
  if (latest) {
    latest.pulses.forEach((d, i) => {
      const level = i % 2 === 0 ? 1 : 0;
      data.push([acc, level]);
      acc += d;
      data.push([acc, level]);
    });
  }

  wave.setOption(
    {
      animation: false,
      title: {
        text: latest
          ? `最新帧波形 · ${latest.protocol} · ${latest.pulseCount} 脉冲 · ${(latest.durationUs / 1000).toFixed(1)}ms`
          : '最新帧波形',
        left: 8,
        top: 4,
        textStyle: { ...text, fontSize: 12 },
      },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number | string) => (v === 1 ? 'mark' : 'space'),
      },
      dataZoom: [
        { type: 'inside', zoomOnMouseWheel: true, moveOnMouseMove: true },
        { type: 'slider', height: 18, bottom: 4, borderColor: line, textStyle: text },
      ],
      grid: { left: 56, right: 20, top: 32, bottom: 46 },
      xAxis: {
        type: 'value',
        name: 'µs',
        axisLabel: text,
        axisLine: { lineStyle: { color: line } },
        splitLine: { lineStyle: { color: split } },
      },
      yAxis: {
        type: 'value',
        min: -0.2,
        max: 1.2,
        interval: 1,
        axisLabel: { ...text, formatter: (v: number) => (v === 1 ? 'mark' : v === 0 ? 'space' : '') },
        axisLine: { lineStyle: { color: line } },
        splitLine: { show: false },
      },
      series: [
        {
          type: 'line',
          data,
          step: 'end',
          showSymbol: false,
          lineStyle: { width: 1.4, color: primary() },
          itemStyle: { color: primary() },
          areaStyle: { color: primary() + '22' },
        },
      ],
    },
    { notMerge: true },
  );
}

function renderHistAndPie() {
  const dark = isDark();
  const text = { color: dark ? '#aab3c0' : '#606266', fontSize: 11 };
  const line = dark ? '#4c5260' : '#dcdfe6';
  const split = dark ? '#232833' : '#f2f4f8';
  const s = props.samples;

  const edges = [0, 0.3, 0.6, 0.9, 1.2, 1.6, 2.2, 3, 4.5, 6, 9, 13, 20, 30];
  const counts = new Array(edges.length).fill(0);
  for (const sample of s.slice(-100)) {
    for (const p of sample.pulses) {
      const ms = p / 1000;
      let idx = edges.length - 1;
      for (let i = 0; i < edges.length - 1; i++) {
        if (ms >= edges[i] && ms < edges[i + 1]) {
          idx = i;
          break;
        }
      }
      counts[idx]++;
    }
  }
  hist?.setOption(
    {
      animation: false,
      grid: { left: 44, right: 14, top: 28, bottom: 24 },
      title: { text: '脉冲时长分布（最近 100 帧）', left: 8, top: 4, textStyle: { ...text, fontSize: 12 } },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: edges.map((e) => `${e}`),
        name: 'ms',
        axisLabel: text,
        axisLine: { lineStyle: { color: line } },
      },
      yAxis: {
        type: 'value',
        axisLabel: text,
        axisLine: { lineStyle: { color: line } },
        splitLine: { lineStyle: { color: split } },
      },
      series: [{ type: 'bar', data: counts, itemStyle: { color: primary(), borderRadius: [3, 3, 0, 0] } }],
    },
    { notMerge: true },
  );

  const protoCount = new Map<string, number>();
  for (const x of s) protoCount.set(x.protocol, (protoCount.get(x.protocol) ?? 0) + 1);
  pie?.setOption(
    {
      animation: false,
      title: { text: '协议分布', left: 8, top: 4, textStyle: { ...text, fontSize: 12 } },
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: text, type: 'scroll' },
      series: [
        {
          type: 'pie',
          radius: ['35%', '62%'],
          center: ['50%', '52%'],
          label: { ...text },
          data: [...protoCount.entries()].map(([name, value]) => ({ name, value })),
        },
      ],
    },
    { notMerge: true },
  );
}

function render() {
  renderStock();
  renderWave();
  renderHistAndPie();
}

function onResize() {
  for (const c of [stock, wave, hist, pie]) c?.resize();
}

onMounted(() => {
  stock = echarts.init(stockEl.value!);
  wave = echarts.init(waveEl.value!);
  hist = echarts.init(histEl.value!);
  pie = echarts.init(pieEl.value!);
  render();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  for (const c of [stock, wave, hist, pie]) c?.dispose();
  stock = wave = hist = pie = null;
});

watch(() => props.samples, render, { deep: true });
</script>

<template>
  <div class="rt-panel">
    <div ref="stockEl" class="rt-chart stock" />
    <div ref="waveEl" class="rt-chart wave" />
    <div class="rt-row">
      <div ref="histEl" class="rt-chart half" />
      <div ref="pieEl" class="rt-chart half" />
    </div>
  </div>
</template>

<style scoped lang="scss">
.rt-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rt-chart {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--app-radius, 8px);
  background: var(--el-bg-color);
}
.stock {
  height: 460px;
}
.wave {
  height: 300px;
}
.rt-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.half {
  height: 260px;
}
@media (max-width: 900px) {
  .rt-row {
    grid-template-columns: 1fr;
  }
}
</style>
