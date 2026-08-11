<script setup lang="ts">
/**
 * 预设发射按钮卡片。
 * - 单击：发射一次（按 settings.transmit.repeatCount/intervalMs 做软件增强重发）
 * - 长按（>400ms）：连发模式，按 intervalMs 间隔循环重发，松开停止
 * - preset.blob 直接发射；只有 train 的先 raw→module 转 blob 再发
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { IrBlob, Preset } from '../types/ir';
import { hw } from '../lib/hardware';
import { formatFromCanonical } from '../lib/convert';
import { useHardwareStore } from '../stores/hardware';
import { usePresetsStore } from '../stores/presets';
import { useSettingsStore } from '../stores/settings';

const props = defineProps<{
  preset: Preset;
  /** 无硬件时置灰 */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  edit: [preset: Preset];
  remove: [preset: Preset];
}>();

const hardware = useHardwareStore();
const presets = usePresetsStore();
const settings = useSettingsStore();

const LONG_PRESS_MS = 400;

const transmitting = ref(false);
const repeating = ref(false);
const repeatCount = ref(0);

let pressTimer: number | null = null;
let stopRepeat = false;

const hasCode = computed(() => Boolean(props.preset.blob?.length || props.preset.train?.pulses?.length));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? '未知错误';
}

/** pulses（µs 时间线）→ 模块 blob */
function pulsesToBlob(carrierHz: number, pulses: number[]): IrBlob {
  const hex = formatFromCanonical({ carrierHz, pulses }, 'module');
  return hex.split(/\s+/).map((h) => parseInt(h, 16));
}

function resolveBlob(): IrBlob | null {
  if (props.preset.blob?.length) return props.preset.blob;
  if (props.preset.train?.pulses?.length) {
    return pulsesToBlob(props.preset.train.carrierHz, props.preset.train.pulses);
  }
  return null;
}

async function transmitOnce(): Promise<void> {
  const blob = resolveBlob();
  if (!blob) {
    ElMessage.warning(`「${props.preset.name}」没有可发射的码数据`);
    return;
  }
  await hw.transmitBlob(blob);
  hardware.incTx();
}

/** 单击：按功率档（重复次数）发射 */
async function fire(): Promise<void> {
  if (props.disabled || transmitting.value || repeating.value) return;
  transmitting.value = true;
  try {
    const times = Math.max(1, settings.transmit.repeatCount);
    for (let i = 0; i < times; i++) {
      await transmitOnce();
      if (i < times - 1) await sleep(settings.transmit.intervalMs);
    }
    presets.incUse(props.preset.id);
  } catch (e) {
    ElMessage.error(`发射失败：${errText(e)}`);
  } finally {
    transmitting.value = false;
  }
}

/** 长按进入连发：按间隔循环重发，松开停止 */
async function startRepeat(): Promise<void> {
  if (props.disabled || repeating.value) return;
  repeating.value = true;
  repeatCount.value = 0;
  try {
    while (!stopRepeat) {
      await transmitOnce();
      repeatCount.value += 1;
      presets.incUse(props.preset.id);
      await sleep(settings.transmit.intervalMs);
    }
  } catch (e) {
    ElMessage.error(`连发中断：${errText(e)}`);
  } finally {
    repeating.value = false;
  }
}

function onPointerDown(): void {
  if (props.disabled) return;
  stopRepeat = false;
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    void startRepeat();
  }, LONG_PRESS_MS);
}

function onPointerEnd(): void {
  if (pressTimer !== null) {
    // 未达长按时长 → 视为单击
    window.clearTimeout(pressTimer);
    pressTimer = null;
    void fire();
  } else if (repeating.value) {
    stopRepeat = true;
  }
}

onBeforeUnmount(() => {
  if (pressTimer !== null) window.clearTimeout(pressTimer);
  stopRepeat = true;
});
</script>

<template>
  <div
    class="preset-btn"
    :class="{ disabled, transmitting, repeating }"
    @pointerdown="onPointerDown"
    @pointerup="onPointerEnd"
    @pointerleave="onPointerEnd"
    @pointercancel="onPointerEnd"
  >
    <div class="pb-actions" @pointerdown.stop @pointerup.stop>
      <el-icon class="act" title="编辑" @click.stop="emit('edit', preset)"><Edit /></el-icon>
      <el-icon class="act danger" title="删除" @click.stop="emit('remove', preset)"><Delete /></el-icon>
    </div>

    <div class="pb-icon">
      <el-icon :size="22"><Promotion /></el-icon>
    </div>
    <div class="pb-name" :title="preset.name">{{ preset.name }}</div>
    <div class="pb-meta">
      <el-tag size="small" effect="plain">{{ preset.category || '未分类' }}</el-tag>
      <el-tag v-if="preset.protocol" size="small" type="info" effect="plain">{{ preset.protocol }}</el-tag>
    </div>
    <div class="pb-foot">
      <span class="use-count">使用 {{ preset.useCount }} 次</span>
      <span v-if="!hasCode" class="no-code">无码数据</span>
    </div>

    <div v-if="repeating" class="tx-overlay">
      <span class="tx-dot" />
      连发中 ×{{ repeatCount }}（松开停止）
    </div>
    <div v-else-if="transmitting" class="tx-overlay">
      <span class="tx-dot" />
      发射中…
    </div>
  </div>
</template>

<style scoped lang="scss">
.preset-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 10px 12px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  background-color: var(--el-bg-color);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
  transition: border-color var(--app-anim-duration), background-color var(--app-anim-duration);

  &:hover {
    border-color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);

    .pb-actions {
      opacity: 1;
    }
  }

  &.disabled {
    cursor: not-allowed;
    opacity: 0.45;

    &:hover {
      border-color: var(--el-border-color-light);
      background-color: var(--el-bg-color);

      .pb-actions {
        opacity: 0;
      }
    }
  }

  &.transmitting,
  &.repeating {
    border-color: var(--el-color-primary);
  }
}

.pb-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity var(--app-anim-duration);
  z-index: 2;

  .act {
    font-size: 14px;
    color: var(--el-text-color-secondary);
    padding: 2px;

    &:hover {
      color: var(--el-color-primary);
    }

    &.danger:hover {
      color: var(--el-color-danger);
    }
  }
}

.pb-icon {
  color: var(--el-color-primary);
}

.pb-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pb-meta {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}

.pb-foot {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);

  .no-code {
    color: var(--el-color-warning);
  }
}

.tx-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
  z-index: 1;
}

.tx-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: var(--el-color-primary);
  animation: tx-pulse calc(var(--app-anim-duration) * 3) ease-in-out infinite;
}

@keyframes tx-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(1.6);
  }
}
</style>
