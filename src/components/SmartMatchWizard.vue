<script setup lang="ts">
/**
 * 「有反应」式智能匹配向导：
 * 选品牌+品类 → SmartMatcher 逐个出测试码（power 优先）→ 发射 → 用户反馈收敛
 * → 命中后展示整套键码并可批量存预设；候选耗尽引导学习模式。
 */
import { computed, ref, shallowRef } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { CodeEntry, IrBlob } from '../types/ir';
import { hw } from '../lib/hardware';
import { formatFromCanonical } from '../lib/convert';
import { listBrands, listDeviceTypes, SmartMatcher } from '../lib/codelib';
import { useHardwareStore } from '../stores/hardware';
import { usePresetsStore } from '../stores/presets';

const props = defineProps<{
  /** 无硬件时禁用发射 */
  disabled?: boolean;
}>();

const router = useRouter();
const hardware = useHardwareStore();
const presets = usePresetsStore();

type Phase = 'select' | 'testing' | 'matched' | 'exhausted';

const phase = ref<Phase>('select');
const brand = ref('');
const deviceType = ref('');
const matcher = shallowRef<SmartMatcher | null>(null);
const currentTest = ref<CodeEntry | null>(null);
const transmitting = ref(false);
/** 触发模板中 matcher 状态刷新（matcher 非响应式类） */
const tick = ref(0);

const allBrands = listBrands();
const deviceTypeOptions = listDeviceTypes();

const brandFilterText = ref('');
const brandOptions = computed(() => {
  const q = brandFilterText.value.trim().toLowerCase();
  if (!q) return allBrands;
  return allBrands.filter(
    (b) => b.name.toLowerCase().includes(q) || b.aliases.some((a) => a.toLowerCase().includes(q)),
  );
});

function brandFilter(q: string): void {
  brandFilterText.value = q;
}

const brandDeviceTypes = computed(() => {
  const b = allBrands.find((x) => x.name === brand.value);
  return deviceTypeOptions.filter((d) => b?.deviceTypes.includes(d.deviceType));
});

function onBrandChange(): void {
  deviceType.value = '';
}

const candidateTotal = computed(() => {
  void tick.value;
  return matcher.value?.total ?? 0;
});
const candidateIndex = computed(() => {
  void tick.value;
  return (matcher.value?.index ?? 0) + 1;
});
const matchedResult = computed<CodeEntry[] | null>(() => {
  void tick.value;
  return matcher.value?.result ?? null;
});

function start(): void {
  if (!brand.value || !deviceType.value) {
    ElMessage.warning('请先选择品牌与品类');
    return;
  }
  const m = new SmartMatcher(brand.value, deviceType.value);
  if (m.total === 0) {
    ElMessage.warning('离线码库中没有该品牌+品类的候选码，请尝试在线码库或学习模式');
    return;
  }
  matcher.value = m;
  currentTest.value = m.next();
  phase.value = 'testing';
  tick.value++;
}

function pulsesToBlob(carrierHz: number, pulses: number[]): IrBlob {
  const hex = formatFromCanonical({ carrierHz, pulses }, 'module');
  return hex.split(/\s+/).map((h) => parseInt(h, 16));
}

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? '未知错误';
}

async function transmitEntry(entry: CodeEntry): Promise<boolean> {
  try {
    await hw.transmitBlob(pulsesToBlob(entry.carrierHz, entry.pulses));
    hardware.incTx();
    return true;
  } catch (e) {
    ElMessage.error(`发射失败：${errText(e)}`);
    return false;
  }
}

async function fireTest(): Promise<void> {
  if (props.disabled || !currentTest.value || transmitting.value) return;
  transmitting.value = true;
  try {
    await transmitEntry(currentTest.value);
  } finally {
    transmitting.value = false;
  }
}

async function fireEntry(entry: CodeEntry): Promise<void> {
  if (props.disabled) return;
  if (await transmitEntry(entry)) ElMessage.success(`已发射「${entry.keyName}」`);
}

function feedback(worked: boolean): void {
  const m = matcher.value;
  if (!m) return;
  m.feedback(worked);
  tick.value++;
  if (worked) {
    phase.value = 'matched';
    ElMessage.success('匹配成功！已收敛到当前遥控方案');
    return;
  }
  const next = m.next();
  if (!next) {
    phase.value = 'exhausted';
  } else {
    currentTest.value = next;
  }
}

function saveAllAsPresets(): void {
  const result = matchedResult.value;
  if (!result?.length) return;
  let n = 0;
  for (const e of result) {
    presets.addPreset({
      name: `${e.brand}·${e.keyName}`,
      category: e.deviceTypeName,
      group: e.brand,
      protocol: e.protocol,
      train: { carrierHz: e.carrierHz, pulses: e.pulses },
      source: 'library',
    });
    n++;
  }
  ElMessage.success(`已保存 ${n} 个预设`);
}

function reset(): void {
  matcher.value?.reset();
  matcher.value = null;
  currentTest.value = null;
  phase.value = 'select';
  tick.value++;
}

function toHex(v?: number): string {
  return v === undefined ? '—' : `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
}
</script>

<template>
  <el-card shadow="never" class="match-wizard">
    <template #header>
      <div class="mw-header">
        <span>智能匹配向导（「有反应」式）</span>
        <el-button v-if="phase !== 'select'" text type="primary" size="small" @click="reset">重新开始</el-button>
      </div>
    </template>

    <!-- 第一步：选择品牌与品类 -->
    <div v-if="phase === 'select'" class="mw-select">
      <p class="tip">
        不知道遥控器型号？选择品牌与品类后，向导会逐个发射测试码（电源键优先），
        你只需回答设备「有反应 / 无反应」，即可自动收敛出整套遥控码。
      </p>
      <div class="select-bar">
        <el-select v-model="brand" placeholder="选择品牌" filterable :filter-method="brandFilter" class="w200" @change="onBrandChange">
          <el-option v-for="b in brandOptions" :key="b.name" :value="b.name" :label="b.name" />
        </el-select>
        <el-select v-model="deviceType" placeholder="选择品类" class="w160">
          <el-option
            v-for="d in brandDeviceTypes"
            :key="d.deviceType"
            :value="d.deviceType"
            :label="`${d.deviceTypeName}（${d.brandCount} 品牌）`"
          />
        </el-select>
        <el-button type="primary" :disabled="!brand || !deviceType" @click="start">开始匹配</el-button>
      </div>
    </div>

    <!-- 第二步：逐个测试 -->
    <div v-else-if="phase === 'testing'" class="mw-testing">
      <div class="cand-info">
        <el-tag effect="plain">候选 {{ candidateIndex }} / {{ candidateTotal }}</el-tag>
        <template v-if="currentTest">
          <el-tag type="info" effect="plain">{{ currentTest.protocol }}</el-tag>
          <span class="mono">地址 {{ toHex(currentTest.address) }}</span>
        </template>
      </div>
      <div v-if="currentTest" class="test-key">
        测试键：<b>{{ currentTest.keyName }}</b>
      </div>
      <el-button
        type="primary"
        size="large"
        class="fire-btn"
        :disabled="disabled"
        :loading="transmitting"
        @click="fireTest"
      >
        <el-icon style="margin-right: 6px"><Promotion /></el-icon>
        发射测试码
      </el-button>
      <p v-if="disabled" class="tip warn">未连接硬件，无法发射测试码</p>
      <div class="fb-bar">
        <span class="fb-q">设备有反应吗？</span>
        <el-button type="success" :disabled="transmitting" @click="feedback(true)">有反应</el-button>
        <el-button type="danger" plain :disabled="transmitting" @click="feedback(false)">无反应，下一个</el-button>
      </div>
    </div>

    <!-- 命中：整套键码 -->
    <div v-else-if="phase === 'matched'" class="mw-matched">
      <el-alert type="success" :closable="false" show-icon class="mb12"
        title="匹配成功"
        :description="`已收敛出 ${matchedResult?.length ?? 0} 个按键码，可直接试发或批量保存为预设。`"
      />
      <div class="mb12">
        <el-button type="primary" @click="saveAllAsPresets">全部存为预设</el-button>
      </div>
      <el-table :data="matchedResult ?? []" size="small" max-height="320" stripe>
        <el-table-column prop="keyName" label="键名" min-width="90" />
        <el-table-column prop="key" label="键标识" min-width="90" show-overflow-tooltip />
        <el-table-column prop="protocol" label="协议" width="100" />
        <el-table-column label="地址" width="80">
          <template #default="{ row }"><span class="mono">{{ toHex(row.address) }}</span></template>
        </el-table-column>
        <el-table-column label="命令" width="80">
          <template #default="{ row }"><span class="mono">{{ toHex(row.command) }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" size="small" :disabled="disabled" @click="fireEntry(row)">试发</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 候选耗尽 -->
    <div v-else class="mw-exhausted">
      <el-alert type="warning" :closable="false" show-icon class="mb12"
        title="候选已耗尽，未找到匹配的遥控方案"
        description="离线码库中没有能让你的设备产生反应的码。建议使用学习模式：把真实遥控器对准红外模块，在「接收」页学习按键并保存为预设；也可以试试「在线码库」页签。"
      />
      <el-button type="primary" @click="router.push('/receive')">前往接收页学习</el-button>
      <el-button @click="reset">重新匹配</el-button>
    </div>
  </el-card>
</template>

<style scoped lang="scss">
.mw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tip {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 0 0 12px;

  &.warn {
    color: var(--el-color-warning);
    margin: 8px 0 0;
  }
}

.select-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.w200 {
  width: 200px;
}
.w160 {
  width: 200px;
}

.mw-testing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 8px 0;

  .cand-info {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .test-key {
    font-size: 14px;
  }

  .fire-btn {
    min-width: 220px;
  }

  .fb-bar {
    display: flex;
    align-items: center;
    gap: 10px;

    .fb-q {
      font-size: 13px;
      color: var(--el-text-color-secondary);
    }
  }
}

.mb12 {
  margin-bottom: 12px;
}
</style>
