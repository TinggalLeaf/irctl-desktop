<script setup lang="ts">
/**
 * 实时捕获图表面板：载波频段折线 / 帧时长折线 / 脉冲时长直方图 / 协议分布饼图。
 * 纯展示组件，数据来自 realtime store，不做任何频段/协议过滤。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';
import type { RtSample } from '../stores/realtime';

defineOptions({ name: 'RealtimePanel' });

const props = defineProps<{ samples: RtSample[] }>();

const carrierEl = ref<HTMLDivElement>();
const durationEl = ref<HTMLDivElement>();
const histEl = ref<HTMLDivElement>();
const pieEl = ref<HTMLDivElement>();

let charts: echarts.ECharts[] = [];

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function baseText(): { color: string; fontSize: number } {
  return { color: isDark() ? '#aab3c0' : '#606266', fontSize: 11 };
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render() {
  if (charts.length < 4) return;
  const s = props.samples;
  const text = baseText();
  const axisCommon = {
    axisLabel: text,
    axisLine: { lineStyle: { color: isDark() ? '#4c5260' : '#dcdfe6' } },
    splitLine: { lineStyle: { color: isDark() ? '#2a2f3a' : '#ebeef5' } },
  };

  // 1) 载波频段折线：不过滤，30-56kHz 参考带
  charts[0].setOption(
    {
      grid: { left: 48, right: 16, top: 28, bottom: 24 },
      title: { text: '载波频段（未过滤）', left: 8, top: 4, textStyle: text },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: s.map((x) => timeLabel(x.ts)), ...axisCommon },
      yAxis: {
        type: 'value',
        name: 'kHz',
        min: 20,
        max: 65,
        ...axisCommon,
      },
      series: [
        {
          type: 'line',
          data: s.map((x) => +(x.carrierHz / 1000).toFixed(2)),
          showSymbol: true,
          symbolSize: 5,
          smooth: true,
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(58,134,255,0.08)' },
            label: { ...text, position: 'insideTop' },
            data: [[{ name: '30-56kHz', yAxis: 30 }, { yAxis: 56 }]],
          },
        },
      ],
    },
    { notMerge: true },
  );

  // 2) 帧时长 / 脉冲数折线
  charts[1].setOption(
    {
      grid: { left: 48, right: 48, top: 28, bottom: 24 },
      title: { text: '帧时长 / 脉冲数', left: 8, top: 4, textStyle: text },
      tooltip: { trigger: 'axis' },
      legend: { right: 8, top: 4, textStyle: text },
      xAxis: { type: 'category', data: s.map((x) => timeLabel(x.ts)), ...axisCommon },
      yAxis: [
        { type: 'value', name: 'ms', ...axisCommon },
        { type: 'value', name: '脉冲', ...axisCommon, splitLine: { show: false } },
      ],
      series: [
        {
          name: '帧时长',
          type: 'line',
          data: s.map((x) => +(x.durationUs / 1000).toFixed(2)),
          smooth: true,
          symbolSize: 4,
        },
        {
          name: '脉冲数',
          type: 'line',
          yAxisIndex: 1,
          data: s.map((x) => x.pulseCount),
          smooth: true,
          symbolSize: 4,
        },
      ],
    },
    { notMerge: true },
  );

  // 3) 脉冲时长分布直方图（最近 50 帧的全部脉冲）
  const edges = [0, 0.3, 0.6, 0.9, 1.2, 1.6, 2.2, 3, 4.5, 6, 9, 13, 20, 30];
  const counts = new Array(edges.length).fill(0);
  for (const sample of s.slice(-50)) {
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
  charts[2].setOption(
    {
      grid: { left: 48, right: 16, top: 28, bottom: 24 },
      title: { text: '脉冲时长分布（最近 50 帧）', left: 8, top: 4, textStyle: text },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: edges.map((e, i) => (i === edges.length - 1 ? `≥${e}` : `${e}`)),
        name: 'ms',
        ...axisCommon,
      },
      yAxis: { type: 'value', ...axisCommon },
      series: [{ type: 'bar', data: counts, itemStyle: { borderRadius: [3, 3, 0, 0] } }],
    },
    { notMerge: true },
  );

  // 4) 协议分布饼图
  const protoCount = new Map<string, number>();
  for (const x of s) protoCount.set(x.protocol, (protoCount.get(x.protocol) ?? 0) + 1);
  charts[3].setOption(
    {
      title: { text: '协议分布', left: 8, top: 4, textStyle: text },
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

function onResize() {
  for (const c of charts) c.resize();
}

onMounted(() => {
  const els = [carrierEl, durationEl, histEl, pieEl];
  charts = els.map((el) => echarts.init(el.value!));
  render();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  for (const c of charts) c.dispose();
  charts = [];
});

watch(() => props.samples, render, { deep: true });
</script>

<template>
  <div class="rt-panel">
    <div ref="carrierEl" class="rt-chart" />
    <div ref="durationEl" class="rt-chart" />
    <div ref="histEl" class="rt-chart" />
    <div ref="pieEl" class="rt-chart" />
  </div>
</template>

<style scoped lang="scss">
.rt-panel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 12px;
}
.rt-chart {
  height: 240px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--app-radius, 8px);
  background: var(--el-bg-color);
}
</style>
