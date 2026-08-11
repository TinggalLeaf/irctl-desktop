<script setup lang="ts">
/**
 * 发射控制页：预设管理（搜索/分类/分组 + 网格发射按钮 + 增删改弹窗）、
 * 功率/信号增强（软件层重复发送）、码库直达测试、序列编辑器。
 */
import { computed, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { Preset } from '../types/ir';
import { hw } from '../lib/hardware';
import { parseToCanonical, formatFromCanonical } from '../lib/convert';
import { searchBrand, listDeviceTypes, getCodes, type BrandInfo } from '../lib/codelib';
import { useHardwareStore } from '../stores/hardware';
import { usePresetsStore } from '../stores/presets';
import { useSettingsStore } from '../stores/settings';
import PresetButton from '../components/PresetButton.vue';
import SequenceEditor from '../components/SequenceEditor.vue';

defineOptions({ name: 'TransmitView' });

const hardware = useHardwareStore();
const presets = usePresetsStore();
const settings = useSettingsStore();

const hwReady = computed(() => hardware.connected);

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? '未知错误';
}

/** pulses（µs）→ 模块 blob */
function pulsesToBlob(carrierHz: number, pulses: number[]): number[] {
  const hex = formatFromCanonical({ carrierHz, pulses }, 'module');
  return hex.split(/\s+/).map((h) => parseInt(h, 16));
}

// ================= 预设编辑弹窗 =================
const COMMON_CATEGORIES = ['空调', '电视', '机顶盒', '盒子', '风扇', '音响', '功放', '投影仪', 'DVD', '灯', '空气净化器'];

const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({
  name: '',
  category: '',
  group: '',
  protocol: '',
  sourceMode: 'blob' as 'blob' | 'library',
  blobHex: '',
  libBrand: '',
  libDeviceType: '',
  libKey: '',
});

const categoryOptions = computed(() => [...new Set([...COMMON_CATEGORIES, ...presets.categories])]);
const groupOptions = computed(() => presets.groups);

const libDeviceTypeOptions = computed(() => {
  if (!form.libBrand) return listDeviceTypes();
  const b = searchBrand(form.libBrand).find((x) => x.name === form.libBrand);
  const all = listDeviceTypes();
  return b ? all.filter((d) => b.deviceTypes.includes(d.deviceType)) : all;
});

const libKeyOptions = computed(() =>
  form.libBrand && form.libDeviceType ? getCodes(form.libBrand, form.libDeviceType) : [],
);

function openCreate(): void {
  editingId.value = null;
  form.name = '';
  form.category = '';
  form.group = '';
  form.protocol = '';
  form.sourceMode = 'blob';
  form.blobHex = '';
  form.libBrand = '';
  form.libDeviceType = '';
  form.libKey = '';
  dialogVisible.value = true;
}

function openEdit(p: Preset): void {
  editingId.value = p.id;
  form.name = p.name;
  form.category = p.category;
  form.group = p.group;
  form.protocol = p.protocol ?? '';
  form.sourceMode = 'blob';
  form.blobHex = p.blob?.length
    ? p.blob.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
    : '';
  form.libBrand = '';
  form.libDeviceType = '';
  form.libKey = '';
  dialogVisible.value = true;
}

/** 解析并校验模块 blob hex，返回字节数组；非法抛错 */
function parseBlobHex(text: string): number[] {
  const clean = text.replace(/0x/gi, '').replace(/[\s,;:\-]+/g, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('非法 hex 字节串');
  }
  parseToCanonical(text, 'module'); // 校验长度字段与 FF FF FF FF 结尾
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function savePreset(): void {
  const name = form.name.trim();
  if (!name) {
    ElMessage.warning('请填写预设名称');
    return;
  }
  let blob: number[] | undefined;
  let train: Preset['train'];
  let protocol = form.protocol.trim() || undefined;

  if (form.sourceMode === 'blob') {
    try {
      blob = parseBlobHex(form.blobHex);
    } catch (e) {
      ElMessage.error(`模块 blob 无效：${errText(e)}`);
      return;
    }
  } else {
    const entry = libKeyOptions.value.find((e) => e.key === form.libKey);
    if (!entry) {
      ElMessage.warning('请选择码库按键');
      return;
    }
    train = { carrierHz: entry.carrierHz, pulses: entry.pulses };
    protocol = entry.protocol;
    if (!form.category) form.category = entry.deviceTypeName;
  }

  const payload = {
    name,
    category: form.category.trim(),
    group: form.group.trim(),
    protocol,
    blob,
    train,
    source: (form.sourceMode === 'library' ? 'library' : 'custom') as Preset['source'],
  };

  if (editingId.value) {
    presets.updatePreset(editingId.value, payload);
    ElMessage.success('预设已更新');
  } else {
    presets.addPreset(payload);
    ElMessage.success('预设已创建');
  }
  dialogVisible.value = false;
}

async function removePreset(p: Preset): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除预设「${p.name}」吗？`, '删除预设', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }
  presets.removePreset(p.id);
  ElMessage.success('已删除');
}

// ================= 码库直达测试 =================
const quickBrandQuery = ref('');
const quickBrand = ref('');
const quickDeviceType = ref('');
const quickFiring = ref('');

const quickBrandOptions = computed<BrandInfo[]>(() => searchBrand(quickBrandQuery.value).slice(0, 50));

const quickDeviceTypeOptions = computed(() => {
  const all = listDeviceTypes();
  const b = quickBrandOptions.value.find((x) => x.name === quickBrand.value);
  return b ? all.filter((d) => b.deviceTypes.includes(d.deviceType)) : [];
});

const quickCodes = computed(() =>
  quickBrand.value && quickDeviceType.value ? getCodes(quickBrand.value, quickDeviceType.value) : [],
);

function onQuickBrandChange(): void {
  quickDeviceType.value = '';
}

async function quickFire(key: string): Promise<void> {
  if (!hwReady.value || quickFiring.value) return;
  const entry = quickCodes.value.find((e) => e.key === key);
  if (!entry) return;
  quickFiring.value = key;
  try {
    await hw.transmitBlob(pulsesToBlob(entry.carrierHz, entry.pulses));
    hardware.incTx();
    ElMessage.success(`已试发「${entry.keyName}」`);
  } catch (e) {
    ElMessage.error(`发射失败：${errText(e)}`);
  } finally {
    quickFiring.value = '';
  }
}
</script>

<template>
  <div class="transmit-view">
    <el-alert
      v-if="!hwReady"
      type="warning"
      show-icon
      :closable="false"
      title="未检测到红外发射硬件"
      description="所有发射功能已禁用。请先在「看板」或「设置」页连接串口红外模块。"
    />

    <!-- 功率调节与信号增强 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>功率调节与信号增强</span>
          <el-tag size="small" type="info" effect="plain">软件增强 = 重复发射</el-tag>
        </div>
      </template>
      <div class="power-bar">
        <span class="pb-label">重复发射次数</span>
        <el-slider
          v-model="settings.transmit.repeatCount"
          :min="1"
          :max="10"
          show-stops
          class="power-slider"
        />
        <span class="mono">{{ settings.transmit.repeatCount }} 次</span>
        <span class="pb-label">间隔</span>
        <el-input-number v-model="settings.transmit.intervalMs" :min="20" :max="2000" :step="10" size="small" />
        <span class="mono">ms</span>
      </div>
      <p class="tip">
        该模块载波与发射功率由硬件固定，这里的「增强」是软件层实现：每次点击按设定次数与间隔重复发送同一码；
        长按预设按钮则进入连发模式，按此间隔循环重发，松开停止。
      </p>
    </el-card>

    <!-- 预设管理 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>预设发射（{{ presets.filtered.length }} / {{ presets.presets.length }}）</span>
          <el-button type="primary" size="small" @click="openCreate">
            <el-icon style="margin-right: 4px"><Plus /></el-icon>新增预设
          </el-button>
        </div>
      </template>

      <div class="filter-bar">
        <el-input v-model="presets.search" placeholder="搜索名称 / 分类 / 分组 / 协议" clearable class="w240">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select v-model="presets.category" placeholder="全部分类" clearable class="w140">
          <el-option v-for="c in presets.categories" :key="c" :value="c" :label="c" />
        </el-select>
        <el-select v-model="presets.group" placeholder="全部分组" clearable class="w140">
          <el-option v-for="g in presets.groups" :key="g" :value="g" :label="g" />
        </el-select>
        <el-button text type="primary" size="small" @click="presets.clearFilters()">清空筛选</el-button>
      </div>

      <div v-if="presets.filtered.length" class="preset-grid">
        <PresetButton
          v-for="p in presets.filtered"
          :key="p.id"
          :preset="p"
          :disabled="!hwReady"
          @edit="openEdit"
          @remove="removePreset"
        />
      </div>
      <el-empty v-else description="暂无预设，点击右上角「新增预设」创建（支持自定义发送码）" :image-size="70" />
    </el-card>

    <!-- 码库直达测试 -->
    <el-card shadow="never">
      <template #header><span>码库直达测试</span></template>
      <div class="filter-bar">
        <el-input v-model="quickBrandQuery" placeholder="搜索品牌（支持别名，如 sony）" clearable class="w240">
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
        <el-select
          v-model="quickBrand"
          placeholder="选择品牌"
          filterable
          class="w160"
          @change="onQuickBrandChange"
        >
          <el-option v-for="b in quickBrandOptions" :key="b.name" :value="b.name" :label="b.name" />
        </el-select>
        <el-select v-model="quickDeviceType" placeholder="选择品类" class="w140">
          <el-option
            v-for="d in quickDeviceTypeOptions"
            :key="d.deviceType"
            :value="d.deviceType"
            :label="d.deviceTypeName"
          />
        </el-select>
      </div>
      <div v-if="quickCodes.length" class="key-grid">
        <el-button
          v-for="e in quickCodes"
          :key="e.id"
          size="small"
          :disabled="!hwReady"
          :loading="quickFiring === e.key"
          @click="quickFire(e.key)"
        >{{ e.keyName }}</el-button>
      </div>
      <el-empty v-else description="搜索并选择品牌与品类后，点按键即可直接试发" :image-size="60" />
    </el-card>

    <!-- 序列编辑器 -->
    <SequenceEditor :disabled="!hwReady" />

    <!-- 新增 / 编辑预设弹窗 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑预设' : '新增预设'"
      width="560px"
      destroy-on-close
    >
      <el-form label-width="88px" label-position="left">
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如：客厅空调·制冷26度" />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" placeholder="选择或输入分类" filterable allow-create clearable class="full">
            <el-option v-for="c in categoryOptions" :key="c" :value="c" :label="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="分组">
          <el-select v-model="form.group" placeholder="选择或输入分组（如：客厅）" filterable allow-create clearable class="full">
            <el-option v-for="g in groupOptions" :key="g" :value="g" :label="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="码来源">
          <el-radio-group v-model="form.sourceMode">
            <el-radio-button value="blob">模块 blob hex</el-radio-button>
            <el-radio-button value="library">从码库选码</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-if="form.sourceMode === 'blob'">
          <el-form-item label="协议">
            <el-input v-model="form.protocol" placeholder="可选，如 NEC / SONY" />
          </el-form-item>
          <el-form-item label="blob hex" required>
            <el-input
              v-model="form.blobHex"
              type="textarea"
              :rows="4"
              placeholder="完整模块码（含 2 字节长度与 FF FF FF FF 结尾），支持空格/逗号分隔"
            />
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item label="品牌" required>
            <el-select v-model="form.libBrand" filterable class="full" @change="form.libDeviceType = ''; form.libKey = ''">
              <el-option v-for="b in searchBrand('')" :key="b.name" :value="b.name" :label="b.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="品类" required>
            <el-select v-model="form.libDeviceType" class="full" @change="form.libKey = ''">
              <el-option
                v-for="d in libDeviceTypeOptions"
                :key="d.deviceType"
                :value="d.deviceType"
                :label="d.deviceTypeName"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="按键" required>
            <el-select v-model="form.libKey" filterable class="full">
              <el-option
                v-for="e in libKeyOptions"
                :key="e.id"
                :value="e.key"
                :label="`${e.keyName}（${e.protocol}）`"
              />
            </el-select>
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="savePreset">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.transmit-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.power-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;

  .pb-label {
    font-size: 13px;
    color: var(--el-text-color-secondary);
  }

  .power-slider {
    flex: 1;
    min-width: 180px;
    max-width: 420px;
  }
}

.tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.w240 {
  width: 240px;
}
.w160 {
  width: 160px;
}
.w140 {
  width: 140px;
}
.full {
  width: 100%;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}

.key-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  .el-button {
    margin-left: 0;
  }
}
</style>
