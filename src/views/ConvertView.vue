<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { convert, detectFormat, parseToCanonical } from '../lib/convert';
import type { CanonicalSignal, ConvertFormat } from '../types/ir';

defineOptions({ name: 'ConvertView' });

/* ---------------- 格式选项 ---------------- */
const FORMAT_LABELS: Record<ConvertFormat, string> = {
  auto: '自动识别',
  pronto: 'Pronto Hex',
  lirc: 'LIRC',
  broadlink_hex: 'Broadlink Hex',
  broadlink_b64: 'Broadlink Base64',
  raw: 'Raw µs 数组',
  json: 'JSON',
  xml: 'XML',
  module: '模块 blob Hex',
};
const INPUT_FORMATS: ConvertFormat[] = [
  'auto', 'pronto', 'lirc', 'broadlink_hex', 'broadlink_b64', 'raw', 'json', 'xml', 'module',
];
const OUTPUT_FORMATS = INPUT_FORMATS.filter((f) => f !== 'auto');

/** 下载文件扩展名 */
const DOWNLOAD_EXT: Partial<Record<ConvertFormat, string>> = {
  pronto: 'pronto.txt',
  lirc: 'conf',
  broadlink_hex: 'hex.txt',
  broadlink_b64: 'b64.txt',
  raw: 'raw.txt',
  json: 'json',
  xml: 'xml',
  module: 'blob.hex.txt',
};

/* ---------------- 常用示例 ---------------- */
const EXAMPLES = [
  {
    label: 'NEC Pronto 样例',
    text: '0000 006D 0022 0002 0157 00AC 0015 0040 0015 0040 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0040 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0015 0040 0015 0040 0015 0040 0015 0015 0015 0040 0015 0040 0015 0040 0015 0689 0157 0056 0015 0E94',
  },
  {
    label: 'Broadlink Base64 样例',
    text: 'JgBGAJKVETkRORA6EBYRFBEUEBUQFDkUNhQ3FDYUNhQ2FDYUNhQRFBEUERQRFBE4ETkRORE5ETkRORE5ERUROREUEBQRFBEUEBQRFBEUEBQRORE5ETkSNxE5ETkRORA6EBYRFBAADQUAAA==',
  },
  {
    label: 'Raw µs 样例（NEC 帧）',
    text: '9000, 4500, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560, 560, 1690, 560, 560, 560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560, 560',
  },
];
const exampleSel = ref('');

function fillExample(label: string) {
  const ex = EXAMPLES.find((e) => e.label === label);
  if (ex) {
    input.value = ex.text;
    if (mode.value === 'simple') runSimple();
  }
  exampleSel.value = '';
}

/* ---------------- 基础状态 ---------------- */
const mode = ref<'simple' | 'pipeline'>('simple');
const input = ref('');
const fromFormat = ref<ConvertFormat>('auto');
const toFormat = ref<ConvertFormat>('pronto');
const output = ref('');
const errorMsg = ref('');

/** 自动识别结果（仅输入格式为 auto 时） */
const detected = computed<ConvertFormat | null>(() => {
  if (fromFormat.value !== 'auto' || !input.value.trim()) return null;
  try {
    return detectFormat(input.value);
  } catch {
    return null;
  }
});

/* ---------------- 单次转换 ---------------- */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function runSimple() {
  if (!input.value.trim()) {
    output.value = '';
    errorMsg.value = '';
    return;
  }
  try {
    output.value = convert(input.value, fromFormat.value, toFormat.value);
    errorMsg.value = '';
  } catch (e) {
    output.value = '';
    errorMsg.value = errText(e);
  }
}

/** 输入/格式变化自动转换（300ms 防抖） */
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
watch([input, fromFormat, toFormat, mode], () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (mode.value === 'simple') runSimple();
  }, 300);
});
onUnmounted(() => clearTimeout(debounceTimer));

/** ⇄ 交换：输出回填输入，格式互换 */
function swap() {
  const det = detected.value;
  const oldTo = toFormat.value;
  toFormat.value = fromFormat.value === 'auto' ? (det && det !== 'auto' ? det : 'pronto') : fromFormat.value;
  fromFormat.value = oldTo;
  input.value = output.value || input.value;
}

/* ---------------- 管线模式 ---------------- */
interface PipeStep {
  id: number;
  to: ConvertFormat;
}
interface StepResult {
  text: string;
  error: string;
}

let stepSeq = 0;
const steps = ref<PipeStep[]>([{ id: ++stepSeq, to: 'raw' }]);

function addStep() {
  steps.value.push({ id: ++stepSeq, to: 'pronto' });
}
function removeStep(i: number) {
  steps.value.splice(i, 1);
}

/** 逐步计算中间结果；某步失败后后续步骤标记为「上游失败」 */
const stepResults = computed<StepResult[]>(() => {
  if (!input.value.trim()) return steps.value.map(() => ({ text: '', error: '' }));
  const out: StepResult[] = [];
  let cur = input.value;
  let fmt: ConvertFormat = fromFormat.value;
  let failed = false;
  for (const s of steps.value) {
    if (failed) {
      out.push({ text: '', error: '上游步骤失败' });
      continue;
    }
    try {
      cur = convert(cur, fmt, s.to);
      out.push({ text: cur, error: '' });
    } catch (e) {
      out.push({ text: '', error: errText(e) });
      failed = true;
    }
    fmt = s.to;
  }
  return out;
});

/** 管线最终结果 = 最后一步成功输出 */
const pipelineFinal = computed(() => {
  for (let i = stepResults.value.length - 1; i >= 0; i--) {
    const r = stepResults.value[i];
    if (r && r.text) return r.text;
  }
  return '';
});

const pipelineError = computed(
  () => stepResults.value.find((r) => r.error && r.error !== '上游步骤失败')?.error ?? '',
);

/** 某步的源格式展示名 */
function stepFromLabel(i: number): string {
  if (i === 0) {
    const f = fromFormat.value === 'auto' ? (detected.value ?? 'auto') : fromFormat.value;
    return FORMAT_LABELS[f];
  }
  const prev = steps.value[i - 1];
  return prev ? FORMAT_LABELS[prev.to] : '';
}

/* ---------------- 输出汇总 ---------------- */
const finalOutput = computed(() => (mode.value === 'simple' ? output.value : pipelineFinal.value));
const finalFormat = computed<ConvertFormat | null>(() => {
  if (mode.value === 'simple') return toFormat.value;
  const last = steps.value[steps.value.length - 1];
  return last ? last.to : null;
});
const finalFormatLabel = computed(() => (finalFormat.value ? FORMAT_LABELS[finalFormat.value] : '—'));

/** 结果信息条：载波 / 脉冲数 / 总时长（由 CanonicalSignal 计算） */
const signalInfo = computed(() => {
  const text = finalOutput.value;
  const fmt = finalFormat.value;
  if (!text || !fmt) return null;
  try {
    const sig: CanonicalSignal = parseToCanonical(text, fmt);
    return {
      carrierHz: sig.carrierHz,
      count: sig.pulses.length,
      totalUs: sig.pulses.reduce((a, b) => a + b, 0),
    };
  } catch {
    return null;
  }
});

/* ---------------- 复制 / 下载 ---------------- */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

function downloadResult() {
  const text = finalOutput.value;
  const fmt = finalFormat.value;
  if (!text || !fmt) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `irctl-convert.${DOWNLOAD_EXT[fmt] ?? 'txt'}`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <div class="convert-view">
    <!-- 工具栏 -->
    <el-card shadow="never">
      <div class="toolbar">
        <el-radio-group v-model="mode" size="small">
          <el-radio-button value="simple">单次转换</el-radio-button>
          <el-radio-button value="pipeline">管线模式</el-radio-button>
        </el-radio-group>

        <el-select
          v-model="exampleSel"
          placeholder="填入常用示例"
          size="small"
          style="width: 190px"
          @change="fillExample"
        >
          <el-option v-for="ex in EXAMPLES" :key="ex.label" :label="ex.label" :value="ex.label" />
        </el-select>

        <div class="spacer" />

        <span class="lbl text-secondary">输入格式</span>
        <el-select v-model="fromFormat" size="small" style="width: 160px">
          <el-option v-for="f in INPUT_FORMATS" :key="f" :label="FORMAT_LABELS[f]" :value="f" />
        </el-select>
        <el-tag
          v-if="fromFormat === 'auto'"
          size="small"
          :type="detected ? 'success' : 'info'"
          effect="plain"
        >
          {{ detected ? `识别为 ${FORMAT_LABELS[detected]}` : '待识别' }}
        </el-tag>

        <template v-if="mode === 'simple'">
          <el-button size="small" :disabled="!output" @click="swap">⇄ 交换</el-button>
          <span class="lbl text-secondary">输出格式</span>
          <el-select v-model="toFormat" size="small" style="width: 160px">
            <el-option v-for="f in OUTPUT_FORMATS" :key="f" :label="FORMAT_LABELS[f]" :value="f" />
          </el-select>
          <el-button type="primary" size="small" @click="runSimple">转换</el-button>
        </template>
      </div>
    </el-card>

    <!-- 输入 / 输出大卡 -->
    <el-card shadow="never" class="io-card">
      <div class="io-grid">
        <div class="io-pane">
          <div class="pane-head">
            <span class="pane-title">输入</span>
            <span class="text-secondary">{{ FORMAT_LABELS[fromFormat] }}</span>
          </div>
          <el-input
            v-model="input"
            type="textarea"
            :rows="14"
            class="mono-area"
            placeholder="粘贴红外码（Pronto / LIRC / Broadlink / Raw / JSON / XML / 模块 blob）…"
          />
          <div v-if="mode === 'simple' && errorMsg" class="err-line">{{ errorMsg }}</div>
        </div>

        <div class="io-arrow">
          <el-icon :size="20"><Right /></el-icon>
        </div>

        <div class="io-pane">
          <div class="pane-head">
            <span class="pane-title">输出</span>
            <span class="text-secondary">{{ finalFormatLabel }}</span>
          </div>
          <el-input
            :model-value="finalOutput"
            type="textarea"
            :rows="14"
            readonly
            class="mono-area"
            placeholder="转换结果（输入后自动转换）"
          />
          <div v-if="mode === 'pipeline' && pipelineError" class="err-line">{{ pipelineError }}</div>
          <div class="io-actions">
            <el-button size="small" :disabled="!finalOutput" @click="copyText(finalOutput)">
              <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制
            </el-button>
            <el-button size="small" :disabled="!finalOutput" @click="downloadResult">
              <el-icon style="margin-right: 4px"><Download /></el-icon>下载
            </el-button>
            <template v-if="signalInfo">
              <el-tag size="small" effect="plain">载波 {{ (signalInfo.carrierHz / 1000).toFixed(1) }} kHz</el-tag>
              <el-tag size="small" effect="plain">脉冲 {{ signalInfo.count }} 个</el-tag>
              <el-tag size="small" effect="plain">总时长 {{ (signalInfo.totalUs / 1000).toFixed(1) }} ms</el-tag>
            </template>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 管线步骤 -->
    <el-card v-if="mode === 'pipeline'" shadow="never">
      <template #header>
        <div class="card-header">
          <span>转换管线（{{ steps.length }} 步）</span>
          <el-button size="small" type="primary" plain @click="addStep">
            <el-icon style="margin-right: 4px"><Plus /></el-icon>添加步骤
          </el-button>
        </div>
      </template>

      <div v-if="!steps.length" class="pipe-empty text-secondary">
        暂无步骤，点击「添加步骤」开始叠加转换
      </div>

      <div v-for="(s, i) in steps" :key="s.id" class="pipe-step">
        <div class="pipe-head">
          <el-tag size="small">第 {{ i + 1 }} 步</el-tag>
          <span class="text-secondary pipe-from">{{ stepFromLabel(i) }}</span>
          <el-icon><Right /></el-icon>
          <el-select v-model="s.to" size="small" style="width: 170px">
            <el-option v-for="f in OUTPUT_FORMATS" :key="f" :label="FORMAT_LABELS[f]" :value="f" />
          </el-select>
          <div class="spacer" />
          <el-button size="small" text type="danger" @click="removeStep(i)">
            <el-icon style="margin-right: 2px"><Delete /></el-icon>删除
          </el-button>
        </div>
        <div class="pipe-result">
          <div v-if="stepResults[i] && stepResults[i].error" class="err-line">
            {{ stepResults[i].error }}
          </div>
          <pre v-else-if="stepResults[i] && stepResults[i].text" class="step-pre mono">{{ stepResults[i].text }}</pre>
          <div v-else class="text-secondary pipe-wait">等待输入…</div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.convert-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.spacer {
  flex: 1;
}

.lbl {
  font-size: 13px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.io-grid {
  display: flex;
  gap: 12px;
  align-items: stretch;
}

.io-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.io-arrow {
  display: flex;
  align-items: center;
  color: var(--el-text-color-secondary);
}

.pane-head {
  display: flex;
  align-items: baseline;
  gap: 10px;

  .pane-title {
    font-weight: 600;
  }
}

.mono-area {
  :deep(textarea) {
    font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.5;
  }
}

.err-line {
  color: var(--el-color-danger);
  font-size: 12.5px;
  line-height: 1.5;
  word-break: break-all;
}

.io-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pipe-empty {
  text-align: center;
  padding: 16px 0;
  font-size: 13px;
}

.pipe-step {
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  padding: 10px 12px;
  margin-bottom: 10px;

  &:last-child {
    margin-bottom: 0;
  }
}

.pipe-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  .pipe-from {
    font-size: 13px;
  }

  .el-icon {
    color: var(--el-text-color-secondary);
  }
}

.pipe-result {
  .step-pre {
    margin: 0;
    padding: 8px 10px;
    background: var(--el-fill-color-light);
    border-radius: var(--app-radius);
    font-size: 12px;
    line-height: 1.5;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .pipe-wait {
    font-size: 12.5px;
    padding: 6px 0;
  }
}
</style>
