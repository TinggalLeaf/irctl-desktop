<script setup lang="ts">
/**
 * 码库页：离线码库（品牌模糊搜索 / 品类浏览 / 键码表 / 试发 / 存预设）、
 * 在线码库（Kookong：品类→品牌→遥控器 ID→键码，失败优雅降级）、智能匹配向导。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { CodeEntry } from '../types/ir';
import { hw } from '../lib/hardware';
import { formatFromCanonical } from '../lib/convert';
import {
  CODELIB_VERSION,
  loadOfflineLibrary,
  listBrands,
  listDeviceTypes,
  searchBrand,
  getCodes,
  setOnlineEnabled,
  getBrands,
  getRemotes,
  getIrData,
  KOOKONG_DEVICE_TYPE,
  type KookongBrand,
} from '../lib/codelib';
import { useHardwareStore } from '../stores/hardware';
import { usePresetsStore } from '../stores/presets';
import { useLibraryStore } from '../stores/library';
import { useSettingsStore } from '../stores/settings';
import SmartMatchWizard from '../components/SmartMatchWizard.vue';

defineOptions({ name: 'LibraryView' });

const hardware = useHardwareStore();
const presets = usePresetsStore();
const library = useLibraryStore();
const settings = useSettingsStore();

const hwReady = computed(() => hardware.connected);
const activeTab = ref<'offline' | 'online' | 'match'>('offline');

function errText(e: unknown): string {
  return typeof e === 'string' ? e : (e as Error)?.message ?? '未知错误';
}

// ---------- 顶部统计（回填 library store） ----------
onMounted(() => {
  const entries = loadOfflineLibrary();
  library.setInfo(`${CODELIB_VERSION}（离线内置）`, {
    total: entries.length,
    brands: listBrands().length,
    types: listDeviceTypes().length,
  });
});

// ---------- 统一发射：pulses → module blob → transmitBlob → incTx ----------
const firingId = ref('');

async function transmitEntry(entry: CodeEntry): Promise<boolean> {
  const hex = formatFromCanonical({ carrierHz: entry.carrierHz, pulses: entry.pulses }, 'module');
  const blob = hex.split(/\s+/).map((h) => parseInt(h, 16));
  firingId.value = entry.id;
  try {
    await hw.transmitBlob(blob);
    hardware.incTx();
    ElMessage.success(`已试发「${entry.keyName}」`);
    return true;
  } catch (e) {
    ElMessage.error(`发射失败：${errText(e)}`);
    return false;
  } finally {
    firingId.value = '';
  }
}

function saveAsPreset(entry: CodeEntry): void {
  presets.addPreset({
    name: `${entry.brand}·${entry.keyName}`,
    category: entry.deviceTypeName,
    group: entry.brand,
    protocol: entry.protocol,
    train: { carrierHz: entry.carrierHz, pulses: entry.pulses },
    source: 'library',
  });
  ElMessage.success(`已存为预设「${entry.brand}·${entry.keyName}」`);
}

function toHex(v?: number): string {
  return v === undefined ? '—' : `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
}

// ================= 离线码库 =================
const offQuery = ref('');
const offDeviceType = ref('');
const offBrand = ref('');

const offDeviceTypes = computed(() => listDeviceTypes());

const offBrands = computed(() => {
  let brands = searchBrand(offQuery.value);
  if (offDeviceType.value) {
    brands = brands.filter((b) => b.deviceTypes.includes(offDeviceType.value));
  }
  return brands;
});

const offCodes = computed<CodeEntry[]>(() => {
  if (!offBrand.value) return [];
  const b = listBrands().find((x) => x.name === offBrand.value);
  if (!b) return [];
  const types = offDeviceType.value ? [offDeviceType.value] : b.deviceTypes;
  return types.flatMap((dt) => getCodes(b.name, dt));
});

function pickBrand(name: string): void {
  offBrand.value = name;
}

function onOffTypeChange(): void {
  // 品类变化后当前品牌可能不在该品类下
  if (offBrand.value && offDeviceType.value) {
    const b = listBrands().find((x) => x.name === offBrand.value);
    if (!b?.deviceTypes.includes(offDeviceType.value)) offBrand.value = '';
  }
}

// ================= 在线码库（Kookong） =================
const onDeviceType = ref('');
const onBrands = ref<KookongBrand[]>([]);
const onBrand = ref<KookongBrand | null>(null);
const onRids = ref<number[]>([]);
const onRid = ref<number | null>(null);
const onIrData = ref<unknown>(null);
const brandsLoading = ref(false);
const remotesLoading = ref(false);
const irLoading = ref(false);
const brandsDegraded = ref(false);
const onlineError = ref('');

/** 跟随设置里的在线开关（settings.codelib.onlineEnabled → codelib 模块） */
watch(
  () => settings.codelib.onlineEnabled,
  (v) => setOnlineEnabled(v),
  { immediate: true },
);

const onlineDeviceTypes = computed(() =>
  listDeviceTypes().filter((d) => KOOKONG_DEVICE_TYPE[d.deviceType] !== undefined),
);

async function loadOnlineBrands(): Promise<void> {
  if (!onDeviceType.value) {
    ElMessage.warning('请先选择品类');
    return;
  }
  brandsLoading.value = true;
  onlineError.value = '';
  onBrands.value = [];
  onBrand.value = null;
  onRids.value = [];
  onRid.value = null;
  onIrData.value = null;
  try {
    const list = await getBrands(onDeviceType.value);
    onBrands.value = list;
    brandsDegraded.value = list.length > 0 && list.every((b) => b.offline);
    library.setOnline(!brandsDegraded.value && list.length > 0);
    if (list.length === 0) onlineError.value = '该品类暂无可用的在线品牌';
    else if (brandsDegraded.value) onlineError.value = '在线服务不可用，已降级为离线品牌列表';
  } catch (e) {
    onlineError.value = `品牌列表加载失败：${errText(e)}`;
  } finally {
    brandsLoading.value = false;
  }
}

async function pickOnlineBrand(b: KookongBrand): Promise<void> {
  onBrand.value = b;
  onRids.value = [];
  onRid.value = null;
  onIrData.value = null;
  if (b.offline) return;
  remotesLoading.value = true;
  try {
    const did = KOOKONG_DEVICE_TYPE[onDeviceType.value] ?? 2;
    const res = await getRemotes(did, b.bid);
    if (!res) {
      onlineError.value = '遥控器列表获取失败（网络超时或服务不可用）';
    } else {
      onRids.value = res.rids;
      if (res.rids.length === 0) onlineError.value = '该品牌暂无在线遥控器数据';
    }
  } finally {
    remotesLoading.value = false;
  }
}

async function pullIrData(): Promise<void> {
  if (onRid.value === null || !onBrand.value) return;
  irLoading.value = true;
  onlineError.value = '';
  try {
    const data = await getIrData([onRid.value], onBrand.value.bid, { ackey: 1 });
    if (data === null) {
      onlineError.value = '键码拉取失败（网络超时或服务不可用），请稍后重试或使用离线码库';
      onIrData.value = null;
    } else {
      onIrData.value = data;
    }
  } finally {
    irLoading.value = false;
  }
}

const irDataText = computed(() =>
  onIrData.value === null ? '' : JSON.stringify(onIrData.value, null, 2),
);
</script>

<template>
  <div class="library-view">
    <el-alert
      v-if="!hwReady"
      type="warning"
      show-icon
      :closable="false"
      title="未检测到红外发射硬件"
      description="浏览与保存预设不受影响，「试发」功能已禁用。"
    />

    <!-- 统计 -->
    <el-card shadow="never">
      <div class="stats-row">
        <div class="stat">
          <div class="num">{{ library.totalEntries }}</div>
          <div class="lbl">码库条目</div>
        </div>
        <div class="stat">
          <div class="num">{{ library.brandCount }}</div>
          <div class="lbl">品牌</div>
        </div>
        <div class="stat">
          <div class="num">{{ library.deviceTypeCount }}</div>
          <div class="lbl">品类</div>
        </div>
        <div class="stat">
          <div class="num ver">{{ library.version }}</div>
          <div class="lbl">码库版本</div>
        </div>
        <el-tag :type="library.online ? 'success' : 'info'" effect="plain" class="online-tag">
          在线码库：{{ library.online ? '可用' : '不可用 / 未探测' }}
        </el-tag>
      </div>
    </el-card>

    <el-tabs v-model="activeTab" class="lib-tabs">
      <!-- ============ 离线码库 ============ -->
      <el-tab-pane label="离线码库" name="offline">
        <el-card shadow="never">
          <div class="filter-bar">
            <el-input v-model="offQuery" placeholder="模糊搜索品牌（支持别名，如 sony / Sony）" clearable class="w260">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-radio-group v-model="offDeviceType" size="small" @change="onOffTypeChange">
              <el-radio-button value="">全部品类</el-radio-button>
              <el-radio-button
                v-for="d in offDeviceTypes"
                :key="d.deviceType"
                :value="d.deviceType"
              >{{ d.deviceTypeName }}</el-radio-button>
            </el-radio-group>
          </div>

          <div class="off-body">
            <div class="brand-panel">
              <div class="panel-title">品牌（{{ offBrands.length }}）</div>
              <el-scrollbar max-height="420px">
                <div class="brand-list">
                  <div
                    v-for="b in offBrands"
                    :key="b.name"
                    class="brand-item"
                    :class="{ active: b.name === offBrand }"
                    @click="pickBrand(b.name)"
                  >
                    <span class="bname">{{ b.name }}</span>
                    <span class="bcount">{{ b.entryCount }} 码</span>
                  </div>
                  <el-empty v-if="!offBrands.length" description="无匹配品牌" :image-size="50" />
                </div>
              </el-scrollbar>
            </div>

            <div class="code-panel">
              <div class="panel-title">
                {{ offBrand ? `${offBrand} 的键码（${offCodes.length}）` : '选择左侧品牌查看键码' }}
              </div>
              <el-table v-if="offCodes.length" :data="offCodes" size="small" max-height="420" stripe>
                <el-table-column prop="deviceTypeName" label="品类" width="90" />
                <el-table-column prop="keyName" label="键名" min-width="90" />
                <el-table-column prop="protocol" label="协议" width="110" show-overflow-tooltip />
                <el-table-column label="地址" width="80">
                  <template #default="{ row }"><span class="mono">{{ toHex(row.address) }}</span></template>
                </el-table-column>
                <el-table-column label="命令" width="80">
                  <template #default="{ row }"><span class="mono">{{ toHex(row.command) }}</span></template>
                </el-table-column>
                <el-table-column label="操作" width="130" fixed="right">
                  <template #default="{ row }">
                    <el-button
                      text type="primary" size="small"
                      :disabled="!hwReady"
                      :loading="firingId === row.id"
                      @click="transmitEntry(row)"
                    >试发</el-button>
                    <el-button text type="success" size="small" @click="saveAsPreset(row)">存为预设</el-button>
                  </template>
                </el-table-column>
              </el-table>
              <el-empty v-else description="暂无键码" :image-size="60" />
            </div>
          </div>
        </el-card>
      </el-tab-pane>

      <!-- ============ 在线码库 ============ -->
      <el-tab-pane label="在线码库" name="online">
        <el-card shadow="never">
          <el-alert
            v-if="!settings.codelib.onlineEnabled"
            type="info" show-icon :closable="false" class="mb12"
            title="在线码库已在设置中关闭"
            description="可在「设置 → 码库」中开启在线码库；离线码库不受此开关影响。"
          />
          <template v-else>
            <div class="filter-bar">
              <el-select v-model="onDeviceType" placeholder="选择品类" class="w160">
                <el-option
                  v-for="d in onlineDeviceTypes"
                  :key="d.deviceType"
                  :value="d.deviceType"
                  :label="d.deviceTypeName"
                />
              </el-select>
              <el-button type="primary" :loading="brandsLoading" :disabled="!onDeviceType" @click="loadOnlineBrands">
                加载品牌
              </el-button>
            </div>

            <el-alert
              v-if="onlineError"
              :type="brandsDegraded ? 'warning' : 'error'"
              show-icon :closable="false" class="mb12"
              :title="onlineError"
            />

            <div v-if="onBrands.length" class="online-grid">
              <div class="brand-panel">
                <div class="panel-title">
                  品牌（{{ onBrands.length }}）
                  <el-tag v-if="brandsDegraded" size="small" type="warning" effect="plain">离线降级</el-tag>
                </div>
                <el-scrollbar max-height="380px">
                  <div class="brand-list">
                    <div
                      v-for="b in onBrands"
                      :key="`${b.bid}-${b.name}`"
                      class="brand-item"
                      :class="{ active: onBrand?.name === b.name && onBrand?.bid === b.bid }"
                      @click="pickOnlineBrand(b)"
                    >
                      <span class="bname">{{ b.name }}</span>
                      <el-tag v-if="b.offline" size="small" type="info" effect="plain">离线</el-tag>
                    </div>
                  </div>
                </el-scrollbar>
              </div>

              <div class="code-panel" v-loading="remotesLoading || irLoading">
                <div class="panel-title">
                  {{ onBrand ? `「${onBrand.name}」遥控器与键码` : '选择左侧品牌' }}
                </div>
                <template v-if="onBrand && !onBrand.offline">
                  <div class="rid-bar">
                    <el-select v-model="onRid" placeholder="选择遥控器 ID" class="w200">
                      <el-option v-for="r in onRids" :key="r" :value="r" :label="`遥控器 #${r}`" />
                    </el-select>
                    <el-button
                      type="primary" size="small"
                      :disabled="onRid === null"
                      :loading="irLoading"
                      @click="pullIrData"
                    >拉取键码</el-button>
                  </div>
                  <el-scrollbar v-if="irDataText" max-height="300px" class="ir-json">
                    <pre class="mono">{{ irDataText }}</pre>
                  </el-scrollbar>
                  <el-empty v-else description="选择遥控器 ID 后拉取键码" :image-size="60" />
                </template>
                <el-alert
                  v-else-if="onBrand?.offline"
                  type="info" show-icon :closable="false"
                  title="该品牌来自离线降级列表"
                  description="在线服务不可用，无法拉取遥控器 ID；请切换到「离线码库」页签直接浏览该品牌的键码。"
                />
                <el-empty v-else description="先加载品牌并选择" :image-size="60" />
              </div>
            </div>
            <el-empty v-else-if="!brandsLoading" description="选择品类后点击「加载品牌」" :image-size="70" />
          </template>
        </el-card>
      </el-tab-pane>

      <!-- ============ 智能匹配 ============ -->
      <el-tab-pane label="智能匹配" name="match">
        <SmartMatchWizard :disabled="!hwReady" />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped lang="scss">
.library-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-row {
  display: flex;
  align-items: center;
  gap: 36px;
  flex-wrap: wrap;

  .stat {
    .num {
      font-size: 26px;
      font-weight: 700;
      color: var(--el-color-primary);
      line-height: 1.2;

      &.ver {
        font-size: 15px;
        font-weight: 600;
      }
    }

    .lbl {
      font-size: 12px;
      color: var(--el-text-color-secondary);
      margin-top: 2px;
    }
  }

  .online-tag {
    margin-left: auto;
  }
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.w260 {
  width: 260px;
}
.w200 {
  width: 200px;
}
.w160 {
  width: 160px;
}

.mb12 {
  margin-bottom: 12px;
}

.off-body,
.online-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 14px;
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.brand-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--app-radius);
  border: 1px solid transparent;
  cursor: pointer;
  transition: background-color var(--app-anim-duration), border-color var(--app-anim-duration);

  &:hover {
    background-color: var(--el-color-primary-light-9);
  }

  &.active {
    border-color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);
  }

  .bname {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bcount {
    font-size: 12px;
    color: var(--el-text-color-secondary);
    flex-shrink: 0;
  }
}

.rid-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.ir-json {
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  background-color: var(--el-fill-color-light);

  pre {
    margin: 0;
    padding: 12px;
    font-size: 12px;
    color: var(--el-text-color-primary);
  }
}
</style>
