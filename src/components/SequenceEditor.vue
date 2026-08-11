<script setup lang="ts">
/**
 * 序列编辑器：多步（预设 / 码库码 + 延时）+ 循环次数，按序发射，运行中可停止。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { IrBlob } from '../types/ir';
import { hw } from '../lib/hardware';
import { formatFromCanonical } from '../lib/convert';
import { listBrands, listDeviceTypes, getCodes } from '../lib/codelib';
import { useHardwareStore } from '../stores/hardware';
import { usePresetsStore } from '../stores/presets';

const props = defineProps<{
  /** 无硬件时禁用运行 */
  disabled?: boolean;
}>();

const hardware = useHardwareStore();
const presets = usePresetsStore();

interface SeqStep {
  id: string;
  kind: 'preset' | 'code';
  /** 展示名 */
  label: string;
  /** 本步发射后等待的毫秒数 */
  delayMs: number;
  /** kind=preset */
  presetId?: string;
  /** kind=code：码库条目快照（µs 时间线） */
  code?: {
    brand: string;
    deviceTypeName: string;
    keyName: string;
    protocol: string;
    carrierHz: number;
    pulses: number[];
  };
}

const steps = ref<SeqStep[]>([]);
const loopCount = ref(1);
const running = ref(false);
const curRound = ref(0);
const curStep = ref(0);
let stopFlag = false;

// ---------- 添加步骤 ----------
const addKind = ref<'preset' | 'code'>('preset');
const addPresetId = ref('');
const addBrand = ref('');
const addDeviceType = ref('');
const addKey = ref('');
const addDelay = ref(500);

const brandOptions = listBrands();
const deviceTypeOptions = listDeviceTypes();

const addBrandDeviceTypes = computed(() => {
  const b = brandOptions.find((x) => x.name === addBrand.value);
  return deviceTypeOptions.filter((d) => b?.deviceTypes.includes(d.deviceType));
});

const addKeyOptions = computed(() =>
  addBrand.value && addDeviceType.value ? getCodes(addBrand.value, addDeviceType.value) : [],
);

function onAddBrandChange(): void {
  addDeviceType.value = '';
  addKey.value = '';
}

function onAddDeviceTypeChange(): void {
  addKey.value = '';
}

function addStep(): void {
  if (addKind.value === 'preset') {
    const p = presets.getPreset(addPresetId.value);
    if (!p) {
      ElMessage.warning('请选择要添加的预设');
      return;
    }
    steps.value.push({
      id: crypto.randomUUID(),
      kind: 'preset',
      label: p.name,
      delayMs: addDelay.value,
      presetId: p.id,
    });
  } else {
    const entry = addKeyOptions.value.find((e) => e.key === addKey.value);
    if (!entry) {
      ElMessage.warning('请选择码库按键');
      return;
    }
    steps.value.push({
      id: crypto.randomUUID(),
      kind: 'code',
      label: `${entry.brand}·${entry.keyName}`,
      delayMs: addDelay.value,
      code: {
        brand: entry.brand,
        deviceTypeName: entry.deviceTypeName,
        keyName: entry.keyName,
        protocol: entry.protocol,
        carrierHz: entry.carrierHz,
        pulses: entry.pulses,
      },
    });
  }
}

function moveStep(idx: number, dir: -1 | 1): void {
  const target = idx + dir;
  if (target < 0 || target >= steps.value.length) return;
  const arr = steps.value;
  [arr[idx], arr[target]] = [arr[target], arr[idx]];
}

function removeStep(idx: number): void {
  steps.value.splice(idx, 1);
}

// ---------- 运行 ----------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? '未知错误';
}

function pulsesToBlob(carrierHz: number, pulses: number[]): IrBlob {
  const hex = formatFromCanonical({ carrierHz, pulses }, 'module');
  return hex.split(/\s+/).map((h) => parseInt(h, 16));
}

function resolveStepBlob(step: SeqStep): IrBlob | null {
  if (step.kind === 'preset') {
    const p = step.presetId ? presets.getPreset(step.presetId) : undefined;
    if (!p) return null;
    if (p.blob?.length) return p.blob;
    if (p.train?.pulses?.length) return pulsesToBlob(p.train.carrierHz, p.train.pulses);
    return null;
  }
  if (step.code) return pulsesToBlob(step.code.carrierHz, step.code.pulses);
  return null;
}

const totalActions = computed(() => steps.value.length * Math.max(1, loopCount.value));
const doneActions = computed(() => (curRound.value - 1) * steps.value.length + curStep.value);
const progressPct = computed(() =>
  totalActions.value === 0 ? 0 : Math.round((doneActions.value / totalActions.value) * 100),
);

async function run(): Promise<void> {
  if (props.disabled || running.value) return;
  if (steps.value.length === 0) {
    ElMessage.warning('请先添加序列步骤');
    return;
  }
  running.value = true;
  stopFlag = false;
  try {
    for (let r = 1; r <= Math.max(1, loopCount.value) && !stopFlag; r++) {
      curRound.value = r;
      for (let i = 0; i < steps.value.length && !stopFlag; i++) {
        curStep.value = i + 1;
        const step = steps.value[i];
        const blob = resolveStepBlob(step);
        if (!blob) {
          ElMessage.warning(`步骤「${step.label}」无码数据，已跳过`);
        } else {
          await hw.transmitBlob(blob);
          hardware.incTx();
        }
        if (step.delayMs > 0) await sleep(step.delayMs);
      }
    }
  } catch (e) {
    ElMessage.error(`序列发射中断：${errText(e)}`);
  } finally {
    running.value = false;
    curRound.value = 0;
    curStep.value = 0;
  }
}

function stop(): void {
  stopFlag = true;
}

onBeforeUnmount(() => {
  stopFlag = true;
});
</script>

<template>
  <el-card shadow="never" class="seq-editor">
    <template #header>
      <div class="se-header">
        <span>序列编辑器</span>
        <el-tag size="small" type="info" effect="plain">{{ steps.length }} 步</el-tag>
      </div>
    </template>

    <!-- 添加步骤 -->
    <div class="add-bar">
      <el-radio-group v-model="addKind" size="small">
        <el-radio-button value="preset">预设</el-radio-button>
        <el-radio-button value="code">码库码</el-radio-button>
      </el-radio-group>

      <el-select
        v-if="addKind === 'preset'"
        v-model="addPresetId"
        placeholder="选择预设"
        filterable
        size="small"
        class="w180"
      >
        <el-option v-for="p in presets.presets" :key="p.id" :value="p.id" :label="p.name" />
      </el-select>

      <template v-else>
        <el-select
          v-model="addBrand"
          placeholder="品牌"
          filterable
          size="small"
          class="w140"
          @change="onAddBrandChange"
        >
          <el-option v-for="b in brandOptions" :key="b.name" :value="b.name" :label="b.name" />
        </el-select>
        <el-select
          v-model="addDeviceType"
          placeholder="品类"
          size="small"
          class="w120"
          @change="onAddDeviceTypeChange"
        >
          <el-option
            v-for="d in addBrandDeviceTypes"
            :key="d.deviceType"
            :value="d.deviceType"
            :label="d.deviceTypeName"
          />
        </el-select>
        <el-select v-model="addKey" placeholder="按键" filterable size="small" class="w140">
          <el-option v-for="e in addKeyOptions" :key="e.id" :value="e.key" :label="e.keyName" />
        </el-select>
      </template>

      <el-input-number v-model="addDelay" :min="0" :max="60000" :step="100" size="small" class="w120" />
      <span class="unit">ms 延时</span>
      <el-button type="primary" size="small" @click="addStep">添加步骤</el-button>
    </div>

    <!-- 步骤列表 -->
    <div v-if="steps.length" class="step-list">
      <div v-for="(s, i) in steps" :key="s.id" class="step-item" :class="{ active: running && i + 1 === curStep }">
        <span class="idx">{{ i + 1 }}</span>
        <span class="label" :title="s.label">{{ s.label }}</span>
        <el-tag size="small" effect="plain" :type="s.kind === 'preset' ? 'primary' : 'success'">
          {{ s.kind === 'preset' ? '预设' : '码库' }}
        </el-tag>
        <span class="delay mono">{{ s.delayMs }} ms</span>
        <div class="ops">
          <el-button text size="small" :disabled="i === 0 || running" @click="moveStep(i, -1)">
            <el-icon><Top /></el-icon>
          </el-button>
          <el-button text size="small" :disabled="i === steps.length - 1 || running" @click="moveStep(i, 1)">
            <el-icon><Bottom /></el-icon>
          </el-button>
          <el-button text size="small" type="danger" :disabled="running" @click="removeStep(i)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无步骤，请在上方添加" :image-size="60" />

    <!-- 运行控制 -->
    <div class="run-bar">
      <span>循环次数</span>
      <el-input-number v-model="loopCount" :min="1" :max="99" size="small" :disabled="running" />
      <el-button v-if="!running" type="primary" :disabled="disabled || steps.length === 0" @click="run">
        运行
      </el-button>
      <el-button v-else type="danger" @click="stop">停止</el-button>
      <template v-if="running">
        <el-progress :percentage="progressPct" class="progress" :stroke-width="8" />
        <span class="status-text">第 {{ curRound }}/{{ loopCount }} 轮 · 第 {{ curStep }}/{{ steps.length }} 步</span>
      </template>
    </div>
  </el-card>
</template>

<style scoped lang="scss">
.se-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.add-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;

  .unit {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.w180 {
  width: 180px;
}
.w140 {
  width: 140px;
}
.w120 {
  width: 120px;
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  transition: border-color var(--app-anim-duration), background-color var(--app-anim-duration);

  &.active {
    border-color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);
  }

  .idx {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background-color: var(--el-color-primary-light-8);
    color: var(--el-color-primary);
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .delay {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}

.run-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;

  .progress {
    flex: 1;
    min-width: 120px;
  }

  .status-text {
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }
}
</style>
