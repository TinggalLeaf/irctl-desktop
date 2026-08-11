<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import pkg from '../../package.json';
import { hw } from '../lib/hardware';
import type { PortInfo } from '../types/ir';
import { useSettingsStore, PALETTES } from '../stores/settings';
import { useHardwareStore } from '../stores/hardware';
import { useLibraryStore } from '../stores/library';

const settings = useSettingsStore();
const hwStore = useHardwareStore();
const library = useLibraryStore();

// ---------- 串口 ----------
const ports = ref<PortInfo[]>([]);
const loadingPorts = ref(false);
const testing = ref(false);
const baudOptions = [9600, 19200, 38400, 57600, 115200];

async function refreshPorts() {
  loadingPorts.value = true;
  try {
    ports.value = await hw.listSerialPorts();
  } catch (e) {
    ElMessage.error(`枚举串口失败：${String(e)}`);
  } finally {
    loadingPorts.value = false;
  }
}

async function testConnection() {
  testing.value = true;
  try {
    const caps = await hwStore.detect(
      settings.serial.port || undefined,
      settings.serial.baud,
    );
    if (caps) {
      ElMessage.success(`连接成功：${caps.port} @ ${caps.baud}，存储槽 ${caps.slots} 个`);
    } else {
      ElMessage.error(`连接失败：${hwStore.lastError || '未检测到设备'}`);
    }
  } finally {
    testing.value = false;
  }
}

onMounted(refreshPorts);

// ---------- 主题 ----------
function selectPalette(key: string) {
  settings.theme.palette = key;
}

function onCustomColor(v: string | null) {
  if (v) {
    settings.theme.customColor = v;
    settings.theme.palette = 'custom';
  }
}

// ---------- 码库 ----------
function clearCodelibCache() {
  const n = library.clearCache();
  ElMessage.success(n > 0 ? `已清理 ${n} 条缓存` : '没有可清理的缓存');
}
</script>

<template>
  <div class="settings-page">
    <!-- 串口 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">串口</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="端口">
          <div class="row">
            <el-select
              v-model="settings.serial.port"
              placeholder="选择串口（可手动输入）"
              filterable
              allow-create
              clearable
              style="width: 280px"
              :loading="loadingPorts"
            >
              <el-option
                v-for="p in ports"
                :key="p.portName"
                :label="`${p.portName}（${p.friendlyName}）`"
                :value="p.portName"
              />
            </el-select>
            <el-button :loading="loadingPorts" @click="refreshPorts">
              <el-icon><Refresh /></el-icon><span style="margin-left: 4px">刷新</span>
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="波特率">
          <el-select v-model="settings.serial.baud" style="width: 160px">
            <el-option v-for="b in baudOptions" :key="b" :label="b" :value="b" />
          </el-select>
        </el-form-item>
        <el-form-item label="自动重连">
          <el-switch v-model="settings.serial.autoReconnect" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="testing" @click="testConnection">测试连接</el-button>
          <el-tag v-if="hwStore.connected" type="success" style="margin-left: 12px">
            当前已连接 {{ hwStore.port }} @ {{ hwStore.baud }}
          </el-tag>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 发射 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">发射</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="重复次数">
          <el-input-number v-model="settings.transmit.repeatCount" :min="1" :max="10" />
          <span class="form-tip">软件层连发次数（功率档）</span>
        </el-form-item>
        <el-form-item label="发射间隔">
          <el-input-number v-model="settings.transmit.intervalMs" :min="20" :max="2000" :step="10" />
          <span class="form-tip">毫秒</span>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 接收 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">接收</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="学习模式">
          <el-radio-group v-model="settings.receive.learnMode">
            <el-radio-button value="software">软件（默认）</el-radio-button>
            <el-radio-button value="hardware">硬件</el-radio-button>
          </el-radio-group>
          <span class="form-tip">
            软件：EB 出码 + 软件解码，带实时图表；硬件：E0 学习存入模块槽位
          </span>
        </el-form-item>
        <el-form-item label="解码容差">
          <el-input-number v-model="settings.receive.tolerance" :min="5" :max="50" />
          <span class="form-tip">%</span>
        </el-form-item>
        <el-form-item label="毛刺过滤">
          <el-input-number v-model="settings.receive.glitchFilterUs" :min="0" :max="500" :step="10" />
          <span class="form-tip">µs，小于该宽度的脉冲被滤除</span>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 主题 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">主题</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="外观模式">
          <el-radio-group v-model="settings.theme.mode">
            <el-radio-button value="light">亮色</el-radio-button>
            <el-radio-button value="dark">暗色</el-radio-button>
            <el-radio-button value="oled">OLED 纯黑</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="主题色">
          <div class="palette-row">
            <div
              v-for="p in PALETTES"
              :key="p.key"
              class="swatch"
              :class="{ active: settings.theme.palette === p.key }"
              :style="{ backgroundColor: p.color }"
              :title="p.name"
              @click="selectPalette(p.key)"
            >
              <el-icon v-if="settings.theme.palette === p.key"><Check /></el-icon>
            </div>
            <div class="custom-color" :class="{ active: settings.theme.palette === 'custom' }">
              <el-color-picker
                :model-value="settings.theme.customColor"
                @update:model-value="onCustomColor"
              />
              <span class="text-secondary">自定义</span>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="圆角">
          <el-slider v-model="settings.theme.radius" :min="0" :max="16" show-input style="max-width: 420px" />
        </el-form-item>
        <el-form-item label="字号">
          <el-slider v-model="settings.theme.fontSize" :min="12" :max="18" show-input style="max-width: 420px" />
        </el-form-item>
        <el-form-item label="动画速度">
          <el-slider v-model="settings.theme.animSpeed" :min="0.5" :max="2" :step="0.1" show-input style="max-width: 420px" />
        </el-form-item>
        <el-form-item label="实时预览">
          <div class="preview-row">
            <el-button type="primary">主要按钮</el-button>
            <el-button>次要按钮</el-button>
            <el-tag type="primary">标签</el-tag>
            <el-tag type="success">成功</el-tag>
            <el-switch model-value />
          </div>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 码库 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">码库</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="在线码库">
          <el-switch v-model="settings.codelib.onlineEnabled" />
          <span class="form-tip">关闭后仅使用离线内置码库</span>
        </el-form-item>
        <el-form-item label="缓存时长">
          <el-input-number v-model="settings.codelib.cacheTtl" :min="60" :max="604800" :step="3600" />
          <span class="form-tip">秒</span>
        </el-form-item>
        <el-form-item>
          <el-button @click="clearCodelibCache">清理缓存</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- AI -->
    <el-card shadow="never">
      <template #header><span class="sec-title">AI</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="Base URL">
          <el-input v-model="settings.ai.baseUrl" placeholder="https://api.openai.com/v1" style="max-width: 420px" />
        </el-form-item>
        <el-form-item label="API Key">
          <el-input v-model="settings.ai.apiKey" type="password" show-password placeholder="sk-..." style="max-width: 420px" />
        </el-form-item>
        <el-form-item label="模型">
          <el-input v-model="settings.ai.model" placeholder="gpt-4o-mini" style="max-width: 420px" />
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 语音 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">语音</span></template>
      <el-form label-width="110px" class="sec-form">
        <el-form-item label="语音控制">
          <el-switch v-model="settings.voice.enabled" />
        </el-form-item>
        <el-form-item label="唤醒词">
          <el-input v-model="settings.voice.wakeWord" placeholder="小控" style="max-width: 240px" />
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 关于 -->
    <el-card shadow="never">
      <template #header><span class="sec-title">关于</span></template>
      <div class="about">
        <div class="kv"><span class="k">应用版本</span><span class="mono">v{{ pkg.version }}</span></div>
        <div class="kv"><span class="k">码库版本</span><span class="mono">{{ library.version }}</span></div>
        <div class="kv"><span class="k">技术栈</span><span>Tauri 2 + Vue 3 + Element Plus</span></div>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.settings-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 860px;
}

.sec-title {
  font-weight: 600;
}

.sec-form {
  max-width: 640px;
}

.row {
  display: flex;
  gap: 10px;
  align-items: center;
}

.form-tip {
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.palette-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.swatch {
  width: 34px;
  height: 34px;
  border-radius: var(--app-radius);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  border: 2px solid transparent;
  transition:
    transform var(--app-anim-duration) ease,
    border-color var(--app-anim-duration) ease;

  &:hover {
    transform: scale(1.1);
  }

  &.active {
    border-color: var(--el-color-primary);
    box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
  }
}

.custom-color {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: var(--app-radius);
  border: 1px dashed var(--el-border-color);

  &.active {
    border-color: var(--el-color-primary);
  }
}

.preview-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.about {
  .kv {
    display: flex;
    gap: 16px;
    padding: 6px 0;

    .k {
      width: 90px;
      color: var(--el-text-color-secondary);
    }
  }
}
</style>
