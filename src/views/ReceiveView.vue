<script setup lang="ts">
/**
 * 接收分析页：学习捕获（EB 直出 / E0 入槽 / E9 读槽）→ blob 转 µs 脉宽 →
 * 示波器 / 载波频谱 / 脉冲测量 / 17 协议识别 / Raw 视图与导出 / 一键存预设。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { hw, onIrEvent } from '../lib/hardware';
import { parseToCanonical, formatFromCanonical } from '../lib/convert';
import { decodeFrames } from '../lib/protocol';
import type { DecodedFrame, IrBlob, PulseTrain } from '../types/ir';
import { useHardwareStore } from '../stores/hardware';
import { useSettingsStore } from '../stores/settings';
import { usePresetsStore } from '../stores/presets';
import ScopeCanvas from '../components/ScopeCanvas.vue';
import FftSpectrum from '../components/FftSpectrum.vue';
import PulseMeasureTable from '../components/PulseMeasureTable.vue';

defineOptions({ name: 'ReceiveView' });

const hwStore = useHardwareStore();
const settingsStore = useSettingsStore();
const presetsStore = usePresetsStore();

const hwReady = computed(() => hwStore.connected);

// ---------- 信号数据 ----------
const blob = ref<IrBlob | null>(null);
const train = ref<PulseTrain | null>(null);
const rawText = ref('');
const rawError = ref('');

const cursorA = ref<number | null>(null);
const cursorB = ref<number | null>(null);

const canonical = computed(() =>
  train.value ? { carrierHz: train.value.carrierHz, pulses: train.value.pulses } : null,
);

const blobHex = computed(() => (blob.value ? bytesToHex(blob.value) : ''));

function bytesToHex(b: number[]): string {
  return b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function errMsg(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
}

/** 模块 blob → µs 时间线（走 convert 库 module 解析） */
function handleBlob(b: IrBlob, tip: string) {
  blob.value = b;
  try {
    const sig = parseToCanonical(bytesToHex(b), 'module');
    train.value = { carrierHz: sig.carrierHz, pulses: sig.pulses };
    rawText.value = formatFromCanonical(sig, 'raw');
    rawError.value = '';
    ElMessage.success(tip);
  } catch (e) {
    ElMessage.error(`blob 解析失败：${errMsg(e)}`);
  }
}

// ---------- 学习流程 ----------
const learning = ref(false);
const countdown = ref(0);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

const slotNo = ref(1);
const readingSlot = ref(false);

async function startLearn(slot?: number) {
  try {
    await hw.learnStart(slot);
    learning.value = true;
    countdown.value = 30;
    countdownTimer = setInterval(() => {
      countdown.value -= 1;
      if (countdown.value <= 0) {
        stopLearning();
        ElMessage.warning('学习超时，未收到信号');
      }
    }, 1000);
  } catch (e) {
    ElMessage.error(`启动学习失败：${errMsg(e)}`);
  }
}

function stopLearning() {
  learning.value = false;
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

async function cancelLearn() {
  try {
    await hw.learnCancel();
  } catch {
    /* 取消失败也复位 UI */
  }
  stopLearning();
}

async function readSlot() {
  readingSlot.value = true;
  try {
    const b = await hw.readSlot(slotNo.value);
    handleBlob(b, `已读取槽位 ${slotNo.value}`);
  } catch (e) {
    ElMessage.error(`读取槽位失败：${errMsg(e)}`);
  } finally {
    readingSlot.value = false;
  }
}

// ---------- 硬件事件 ----------
let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await onIrEvent((p) => {
    if (p.kind === 'learned' && p.blob) {
      stopLearning();
      handleBlob(p.blob, `学习成功，收到 ${p.blob.length} 字节`);
    } else if (p.kind === 'ack' && learning.value) {
      // E0 学习到槽位：学成回 ack
      stopLearning();
      ElMessage.success(`学习成功，已写入槽位 ${slotNo.value}`);
    } else if (p.kind === 'error' && learning.value) {
      stopLearning();
      ElMessage.error(p.message ?? '学习失败');
    }
  });
});

onUnmounted(() => {
  unlisten?.();
  if (countdownTimer) clearInterval(countdownTimer);
});

// ---------- 协议识别（容差/毛刺阈值来自设置，可页面临时调整） ----------
const tolPct = ref(settingsStore.receive.tolerance);
const glitchUs = ref(settingsStore.receive.glitchFilterUs);

function resetDecodeOpts() {
  tolPct.value = settingsStore.receive.tolerance;
  glitchUs.value = settingsStore.receive.glitchFilterUs;
}

const decoded = computed<DecodedFrame[]>(() => {
  if (!train.value) return [];
  try {
    return decodeFrames(train.value, {
      tolerance: tolPct.value / 100,
      glitchFilterUs: glitchUs.value,
    });
  } catch {
    return [];
  }
});

function toHex(v: number, pad = 2): string {
  return '0x' + v.toString(16).toUpperCase().padStart(pad, '0');
}

function fmtAddr(f: DecodedFrame): string {
  return f.address != null ? toHex(f.address, f.address > 0xff ? 4 : 2) : '—';
}

function fmtCmd(f: DecodedFrame): string {
  return f.command != null ? toHex(f.command, f.command > 0xff ? 4 : 2) : '—';
}

// ---------- Raw 视图 ----------
function reparseRaw() {
  try {
    const sig = parseToCanonical(rawText.value, 'raw');
    train.value = { carrierHz: sig.carrierHz, pulses: sig.pulses };
    // 同步重建模块 blob，保证 hex 视图 / 导出 / 存预设一致
    const hex = formatFromCanonical(sig, 'module');
    blob.value = hex.split(' ').map((h) => parseInt(h, 16));
    rawError.value = '';
    ElMessage.success('已重新解析');
  } catch (e) {
    rawError.value = errMsg(e);
  }
}

// ---------- 导出 ----------
function tsName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `ir-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

function download(filename: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function doExport(cmd: string) {
  if (!canonical.value || !train.value) return;
  try {
    switch (cmd) {
      case 'json':
        download(tsName('json'), formatFromCanonical(canonical.value, 'json'), 'application/json');
        break;
      case 'csv': {
        const rows = ['index,type,duration_us,start_us'];
        let acc = 0;
        train.value.pulses.forEach((d, i) => {
          rows.push(`${i},${i % 2 === 0 ? 'mark' : 'space'},${Math.round(d)},${Math.round(acc)}`);
          acc += d;
        });
        download(tsName('csv'), rows.join('\n'), 'text/csv');
        break;
      }
      case 'pronto':
        download(tsName('pronto.txt'), formatFromCanonical(canonical.value, 'pronto'));
        break;
      case 'module':
        download(tsName('hex.txt'), formatFromCanonical(canonical.value, 'module'));
        break;
    }
    ElMessage.success('已导出');
  } catch (e) {
    ElMessage.error(`导出失败：${errMsg(e)}`);
  }
}

// ---------- 存为预设 ----------
const saveVisible = ref(false);
const saveForm = reactive({ name: '', category: '', group: '' });

function openSave() {
  if (!train.value) return;
  const top = decoded.value[0];
  saveForm.name = top
    ? `${top.protocol}${top.protocolVariant ? ' ' + top.protocolVariant : ''} ${fmtCmd(top)}`
    : '';
  saveForm.category = '';
  saveForm.group = '';
  saveVisible.value = true;
}

function confirmSave() {
  if (!train.value) return;
  if (!saveForm.name.trim()) {
    ElMessage.warning('请填写名称');
    return;
  }
  presetsStore.addPreset({
    name: saveForm.name.trim(),
    category: saveForm.category || '未分类',
    group: saveForm.group || '默认',
    protocol: decoded.value[0]?.protocol,
    blob: blob.value ? [...blob.value] : undefined,
    train: { carrierHz: train.value.carrierHz, pulses: [...train.value.pulses] },
    source: 'learned',
  });
  saveVisible.value = false;
  ElMessage.success('已保存为预设');
}
</script>

<template>
  <div class="receive-view">
    <el-alert
      v-if="!hwReady"
      type="warning"
      :closable="false"
      show-icon
      title="未检测到红外接收硬件"
      description="学习、读槽等硬件功能不可用。请先在「仪表盘」或「设置」中连接串口红外模块。"
      class="hw-alert"
    />

    <!-- 顶部操作栏 -->
    <el-card shadow="never" class="toolbar-card">
      <div class="toolbar">
        <el-button
          type="primary"
          :disabled="!hwReady || learning"
          @click="startLearn()"
        >
          <el-icon><VideoPlay /></el-icon>&nbsp;开始学习
        </el-button>
        <el-button v-if="learning" type="danger" @click="cancelLearn">
          <el-icon><CircleClose /></el-icon>&nbsp;取消学习（{{ countdown }}s）
        </el-button>
        <el-divider direction="vertical" />
        <el-input-number
          v-model="slotNo"
          :min="1"
          :max="248"
          :disabled="!hwReady || learning"
          class="slot-input"
        />
        <el-button :disabled="!hwReady || learning" @click="startLearn(slotNo)">学习到槽位</el-button>
        <el-button :loading="readingSlot" :disabled="!hwReady || learning" @click="readSlot">
          读取槽位
        </el-button>
        <el-divider direction="vertical" />
        <el-dropdown :disabled="!train" @command="doExport">
          <el-button :disabled="!train">
            <el-icon><Download /></el-icon>&nbsp;导出<el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="json">JSON</el-dropdown-item>
              <el-dropdown-item command="csv">CSV</el-dropdown-item>
              <el-dropdown-item command="pronto">Pronto HEX</el-dropdown-item>
              <el-dropdown-item command="module">模块 HEX</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button type="success" :disabled="!train" @click="openSave">
          <el-icon><Collection /></el-icon>&nbsp;存为预设
        </el-button>
        <el-tag v-if="learning" type="warning" effect="dark" class="learn-tag">
          学习中…请将遥控器对准接收头并按键
        </el-tag>
      </div>
    </el-card>

    <!-- 主区域：左示波器 / 右频谱+测量 -->
    <div class="main-grid">
      <el-card shadow="never" class="scope-card">
        <template #header>
          <div class="card-header">
            <span>波形示波器</span>
            <span class="text-secondary header-hint">滚轮缩放 · 拖动平移 · 双击复位 · 游标测距</span>
          </div>
        </template>
        <ScopeCanvas v-model:cursor-a="cursorA" v-model:cursor-b="cursorB" :train="train" />
      </el-card>

      <div class="side-col">
        <el-card shadow="never">
          <template #header><span>载波频谱（30-56 kHz）</span></template>
          <FftSpectrum :train="train" />
        </el-card>
        <el-card shadow="never">
          <template #header><span>脉冲参数测量</span></template>
          <PulseMeasureTable :train="train" />
        </el-card>
      </div>
    </div>

    <!-- 下方：协议识别 / Raw 视图 -->
    <el-card shadow="never">
      <el-tabs>
        <el-tab-pane label="协议识别">
          <el-collapse class="adv-collapse">
            <el-collapse-item title="高级设置（容差 / 毛刺过滤，仅本页面临时生效）" name="adv">
              <div class="adv-row">
                <span class="adv-label">匹配容差 ±{{ tolPct }}%</span>
                <el-slider v-model="tolPct" :min="5" :max="50" :step="1" class="adv-slider" />
                <span class="adv-label">毛刺过滤</span>
                <el-input-number v-model="glitchUs" :min="0" :max="300" :step="10" size="small" />
                <span class="text-secondary">µs</span>
                <el-button size="small" text type="primary" @click="resetDecodeOpts">恢复默认</el-button>
              </div>
            </el-collapse-item>
          </el-collapse>

          <el-table v-if="decoded.length" :data="decoded" size="small">
            <el-table-column label="协议" min-width="150">
              <template #default="{ row }">
                <span class="proto-name">{{ row.protocol }}</span>
                <el-tag v-if="row.protocolVariant" size="small" effect="plain" class="variant-tag">
                  {{ row.protocolVariant }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="地址" min-width="90">
              <template #default="{ row }"><span class="mono">{{ fmtAddr(row) }}</span></template>
            </el-table-column>
            <el-table-column label="命令" min-width="90">
              <template #default="{ row }"><span class="mono">{{ fmtCmd(row) }}</span></template>
            </el-table-column>
            <el-table-column label="载波" min-width="90">
              <template #default="{ row }">{{ (row.carrierHz / 1000).toFixed(1) }} kHz</template>
            </el-table-column>
            <el-table-column label="帧数" width="70" align="center">
              <template #default="{ row }">{{ row.extra?.frameCount ?? 1 }}</template>
            </el-table-column>
            <el-table-column label="置信度" min-width="160">
              <template #default="{ row }">
                <el-progress
                  :percentage="Math.round(row.confidence * 100)"
                  :stroke-width="8"
                  :status="row.confidence >= 0.8 ? 'success' : ''"
                />
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="未识别（无信号或不匹配已知协议）" :image-size="60" />
        </el-tab-pane>

        <el-tab-pane label="Raw 视图">
          <div class="raw-grid">
            <div class="raw-pane">
              <div class="pane-header">
                <span>µs 脉宽数组（mark 起交替，可编辑）</span>
                <el-button size="small" type="primary" :disabled="!rawText.trim()" @click="reparseRaw">
                  重新解析
                </el-button>
              </div>
              <el-input
                v-model="rawText"
                type="textarea"
                :rows="8"
                class="mono-textarea"
                placeholder="例如：9000, 4500, 560, 560, 560, 1690, ..."
              />
              <div v-if="rawError" class="raw-error">解析失败：{{ rawError }}</div>
            </div>
            <div class="raw-pane">
              <div class="pane-header"><span>模块 blob HEX</span></div>
              <el-input
                :model-value="blobHex"
                type="textarea"
                :rows="8"
                readonly
                class="mono-textarea"
                placeholder="暂无"
              />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 存为预设弹窗 -->
    <el-dialog v-model="saveVisible" title="保存为预设" width="420px">
      <el-form label-width="64px">
        <el-form-item label="名称" required>
          <el-input v-model="saveForm.name" placeholder="如：客厅空调 制冷26℃" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select
            v-model="saveForm.category"
            filterable
            allow-create
            default-first-option
            placeholder="如：空调"
          >
            <el-option v-for="c in presetsStore.categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="分组">
          <el-select
            v-model="saveForm.group"
            filterable
            allow-create
            default-first-option
            placeholder="如：客厅"
          >
            <el-option v-for="g in presetsStore.groups" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="saveVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.receive-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hw-alert {
  flex-shrink: 0;
}

.toolbar-card {
  :deep(.el-card__body) {
    padding: 12px 16px;
  }
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;

  .slot-input {
    width: 110px;
  }

  .learn-tag {
    margin-left: auto;
  }
}

.main-grid {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr);
  gap: 16px;
  align-items: start;
}

.side-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;

  .header-hint {
    font-size: 12px;
    font-weight: 400;
  }
}

.adv-collapse {
  margin-bottom: 12px;

  .adv-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;

    .adv-label {
      font-size: 13px;
      color: var(--el-text-color-regular);
      white-space: nowrap;
    }

    .adv-slider {
      flex: 1;
      min-width: 160px;
      max-width: 320px;
    }
  }
}

.proto-name {
  font-weight: 600;
}

.variant-tag {
  margin-left: 6px;
}

.raw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.raw-pane {
  min-width: 0;

  .pane-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }

  .raw-error {
    margin-top: 6px;
    font-size: 12px;
    color: var(--el-color-danger);
  }
}

.mono-textarea {
  :deep(textarea) {
    font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
    font-size: 12px;
  }
}

@media (max-width: 1100px) {
  .main-grid {
    grid-template-columns: 1fr;
  }

  .raw-grid {
    grid-template-columns: 1fr;
  }
}
</style>
