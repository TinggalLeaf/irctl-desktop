<script setup lang="ts">
/**
 * 脉冲参数自动测量表：总时长、mark/space 统计、引导码、占空比、估计载波。
 */
import { computed } from 'vue';
import type { PulseTrain } from '../types/ir';
import { estimateCarrier } from '../lib/protocol';

defineOptions({ name: 'PulseMeasureTable' });

const props = defineProps<{ train: PulseTrain | null }>();

interface Measure {
  totalUs: number;
  count: number;
  markCount: number;
  spaceCount: number;
  maxMark: number;
  minMark: number;
  maxSpace: number;
  minSpace: number;
  leadMark: number;
  leadSpace: number;
  dutyPct: number;
  carrierHz: number;
  nominalHz: number;
}

const m = computed<Measure | null>(() => {
  const t = props.train;
  if (!t || t.pulses.length < 2) return null;
  const pulses = t.pulses;
  const marks = pulses.filter((_, i) => i % 2 === 0);
  const spaces = pulses.filter((_, i) => i % 2 === 1);
  const total = pulses.reduce((a, b) => a + b, 0);
  const markSum = marks.reduce((a, b) => a + b, 0);
  return {
    totalUs: total,
    count: pulses.length,
    markCount: marks.length,
    spaceCount: spaces.length,
    maxMark: marks.length ? Math.max(...marks) : 0,
    minMark: marks.length ? Math.min(...marks) : 0,
    maxSpace: spaces.length ? Math.max(...spaces) : 0,
    minSpace: spaces.length ? Math.min(...spaces) : 0,
    leadMark: pulses[0],
    leadSpace: pulses[1] ?? 0,
    dutyPct: total > 0 ? (markSum / total) * 100 : 0,
    carrierHz: estimateCarrier(t),
    nominalHz: t.carrierHz,
  };
});

function us(v: number): string {
  return `${Math.round(v).toLocaleString('zh-CN')} µs`;
}
</script>

<template>
  <el-descriptions v-if="m" :column="2" border size="small" class="measure-table">
    <el-descriptions-item label="总时长">{{ us(m.totalUs) }}</el-descriptions-item>
    <el-descriptions-item label="脉冲数">
      {{ m.count }}（mark {{ m.markCount }} / space {{ m.spaceCount }}）
    </el-descriptions-item>
    <el-descriptions-item label="最长 mark">{{ us(m.maxMark) }}</el-descriptions-item>
    <el-descriptions-item label="最短 mark">{{ us(m.minMark) }}</el-descriptions-item>
    <el-descriptions-item label="最长 space">{{ us(m.maxSpace) }}</el-descriptions-item>
    <el-descriptions-item label="最短 space">{{ us(m.minSpace) }}</el-descriptions-item>
    <el-descriptions-item label="引导码（首对）">
      {{ us(m.leadMark) }} + {{ us(m.leadSpace) }}
    </el-descriptions-item>
    <el-descriptions-item label="占空比">{{ m.dutyPct.toFixed(1) }} %</el-descriptions-item>
    <el-descriptions-item label="估计载波">
      <span class="mono">{{ (m.carrierHz / 1000).toFixed(1) }} kHz</span>
    </el-descriptions-item>
    <el-descriptions-item label="标称载波">
      <span class="mono">{{ (m.nominalHz / 1000).toFixed(1) }} kHz</span>
    </el-descriptions-item>
  </el-descriptions>
  <div v-else class="no-data text-secondary">暂无数据 —— 学习或读取信号后自动测量</div>
</template>

<style scoped lang="scss">
.measure-table {
  :deep(.el-descriptions__label) {
    width: 110px;
  }
}

.no-data {
  text-align: center;
  padding: 24px 0;
  font-size: 13px;
}
</style>
