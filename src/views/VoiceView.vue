<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { parseVoice, type VoiceContext } from '../lib/voice';
import { findCode, loadOfflineLibrary } from '../lib/codelib';
import { convert } from '../lib/convert';
import { hw } from '../lib/hardware';
import { useHardwareStore } from '../stores/hardware';
import { useSettingsStore } from '../stores/settings';
import type { CodeEntry, VoiceCommand } from '../types/ir';

defineOptions({ name: 'VoiceView' });

const settings = useSettingsStore();
const hwStore = useHardwareStore();

/* ---------------- Web Speech API（可用性检测） ---------------- */
interface SpeechAlt {
  transcript: string;
}
interface SpeechResultLike {
  isFinal: boolean;
  0: SpeechAlt;
  length: number;
}
interface SpeechEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const SR: SpeechRecognitionCtor | undefined =
  (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
const speechSupported = Boolean(SR);

type RecStatus = 'idle' | 'listening' | 'recognizing' | 'awake';
const STATUS_TEXT: Record<RecStatus, string> = {
  idle: '待机',
  listening: '聆听中',
  recognizing: '识别中',
  awake: '已唤醒',
};

const status = ref<RecStatus>('idle');
const interimText = ref('');
let rec: SpeechRecognitionLike | null = null;
let wantListen = false;

function startListening() {
  if (!SR) return;
  stopListening();
  wantListen = true;
  rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = '';
    let finalText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (!r) continue;
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    interimText.value = interim;
    if (interim.trim()) status.value = 'recognizing';
    if (finalText.trim()) handleFinal(finalText.trim());
  };
  rec.onerror = () => {
    /* 瞬时错误忽略，onend 中按 wantListen 重启 */
  };
  rec.onend = () => {
    if (wantListen) {
      try {
        rec?.start();
        status.value = 'listening';
      } catch {
        /* 已启动 */
      }
    } else {
      status.value = 'idle';
    }
  };
  try {
    rec.start();
    status.value = 'listening';
  } catch {
    /* ignore */
  }
}

function stopListening() {
  wantListen = false;
  try {
    rec?.stop();
  } catch {
    /* ignore */
  }
  rec = null;
  status.value = 'idle';
  interimText.value = '';
}

function onWakeToggle(v: string | number | boolean) {
  if (Boolean(v) && speechSupported) startListening();
  else stopListening();
}

onMounted(() => {
  if (settings.voice.enabled && speechSupported) startListening();
});
onUnmounted(stopListening);

/** 命中唤醒词才进入指令处理 */
function handleFinal(text: string) {
  const wake = (settings.voice.wakeWord || '小控').trim();
  const idx = text.indexOf(wake);
  if (idx === -1) {
    status.value = 'listening';
    return;
  }
  status.value = 'awake';
  interimText.value = '';
  const cmdText = text
    .slice(idx + wake.length)
    .replace(/^[，,、。\s]+/, '')
    .trim();
  if (cmdText) processText(cmdText, true);
  window.setTimeout(() => {
    if (wantListen) status.value = 'listening';
  }, 1500);
}

/* ---------------- 上下文 ---------------- */
const ctx = ref<VoiceContext>({});

const DEVICE_NAMES: Record<string, string> = {
  tv: '电视',
  ac: '空调',
  stb: '机顶盒',
  box: '盒子',
  dvd: 'DVD',
  projector: '投影仪',
  amp: '功放',
  fan: '风扇',
  light: '灯',
  air: '净化器',
  speaker: '音响',
};

function deviceName(dt?: string): string {
  if (!dt) return '未指定';
  return DEVICE_NAMES[dt] ?? dt;
}

const ctxDeviceText = computed(() =>
  ctx.value.lastDeviceType ? deviceName(ctx.value.lastDeviceType) : '未设置',
);
const ctxBrandText = computed(() => ctx.value.lastBrand ?? '未设置');

function clearCtx() {
  ctx.value = {};
  ElMessage.success('上下文已清除');
}

/* ---------------- 动作 → 码库按键 ---------------- */
const ACTION_NAMES: Record<string, string> = {
  power_on: '开机',
  power_off: '关机',
  temp_set: '设定温度',
  temp_up: '温度+',
  temp_down: '温度-',
  vol_up: '音量+',
  vol_down: '音量-',
  vol_set: '设定音量',
  mute: '静音',
  ch_up: '频道+',
  ch_down: '频道-',
  ch_set: '设定频道',
  mode_cool: '制冷',
  mode_heat: '制热',
  mode_fan: '送风',
  mode_dry: '除湿',
  mode_auto: '自动模式',
  swing: '扫风/摇头',
  sleep: '睡眠',
  timer: '定时',
  fan_speed: '风速',
  menu: '菜单',
  ok: '确认',
  back: '返回',
  home: '主页',
  up: '方向上',
  down: '方向下',
  left: '方向左',
  right: '方向右',
  play: '播放',
  pause: '暂停',
  stop: '停止',
  prev: '上一曲',
  next: '下一曲',
  eject: '出仓',
  bright_up: '调亮',
  bright_down: '调暗',
  unknown: '未识别',
};

function actionName(a: string): string {
  return ACTION_NAMES[a] ?? a;
}

/** 语音动作 → 离线码库 key；无对应键返回 null */
function resolveKey(cmd: VoiceCommand): string | null {
  const a = cmd.action;
  if (a === 'power_on' || a === 'power_off') return 'power';
  if (a === 'temp_set') return cmd.value === 26 ? 'temp_26' : null;
  if (a === 'vol_set') return null; // 码库无「音量直设」键
  if (a === 'ch_set') {
    const n = Number(cmd.value);
    return Number.isInteger(n) && n >= 0 && n <= 9 ? `num_${n}` : null;
  }
  const direct = new Set([
    'temp_up', 'temp_down', 'vol_up', 'vol_down', 'mute', 'ch_up', 'ch_down',
    'menu', 'ok', 'back', 'home', 'up', 'down', 'left', 'right',
    'play', 'pause', 'stop', 'prev', 'next', 'eject',
    'mode_cool', 'mode_heat', 'mode_fan', 'mode_dry', 'mode_auto',
    'swing', 'sleep', 'timer', 'fan_speed', 'bright_up', 'bright_down',
  ]);
  return direct.has(a) ? a : null;
}

/** 查码：优先按品牌精确查，缺品牌时跨品牌取该品类该键的第一条 */
function findEntry(cmd: VoiceCommand, key: string): CodeEntry | null {
  const dt = cmd.deviceType ?? ctx.value.lastDeviceType;
  if (!dt) return null;
  const brand = cmd.brand ?? ctx.value.lastBrand;
  if (brand) {
    const exact = findCode(brand, dt, key);
    if (exact) return exact;
  }
  return loadOfflineLibrary().find((e) => e.deviceType === dt && e.key === key) ?? null;
}

/* ---------------- 指令历史 ---------------- */
type ExecStatus = 'pending' | 'ok' | 'notfound' | 'nohw' | 'error';

interface ExecResult {
  action: string;
  key: string | null;
  deviceType?: string;
  brand?: string;
  value?: number | string;
  status: ExecStatus;
  detail: string;
}
interface HistoryItem {
  id: number;
  time: string;
  raw: string;
  commands: VoiceCommand[];
  results: ExecResult[];
  executing: boolean;
}

let histSeq = 0;
const history = ref<HistoryItem[]>([]);

const STATUS_ICON: Record<ExecStatus, string> = {
  ok: 'CircleCheck',
  notfound: 'Warning',
  nohw: 'Warning',
  error: 'CircleClose',
  pending: 'Clock',
};
const STATUS_LABEL: Record<ExecStatus, string> = {
  ok: '已发射',
  notfound: '未找到匹配码',
  nohw: '未连接硬件',
  error: '发射失败',
  pending: '待执行',
};

function statusIcon(s: ExecStatus): string {
  return STATUS_ICON[s];
}

/** 解析文本指令 → 历史条目；auto 且硬件在线时立即执行 */
function processText(text: string, auto: boolean) {
  const cmds = parseVoice(text, ctx.value);
  if (!cmds.length) {
    ElMessage.warning('未解析出有效指令');
    return;
  }
  // 更新上下文（沿用最后一次出现的品类/品牌）
  const merged: VoiceContext = { ...ctx.value };
  for (const c of cmds) {
    if (c.deviceType) merged.lastDeviceType = c.deviceType;
    if (c.brand) merged.lastBrand = c.brand;
  }
  ctx.value = merged;

  const item: HistoryItem = {
    id: ++histSeq,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    raw: text,
    commands: cmds,
    results: cmds.map((c) => ({
      action: c.action,
      key: resolveKey(c),
      deviceType: c.deviceType,
      brand: c.brand,
      value: c.value,
      status: 'pending',
      detail: '',
    })),
    executing: false,
  };
  history.value.unshift(item);
  if (history.value.length > 50) history.value.pop();

  if (auto) {
    if (hwStore.connected) {
      void executeItem(item);
    } else {
      for (const r of item.results) {
        r.status = 'nohw';
        r.detail = '未连接硬件，仅做解析演示';
      }
    }
  }
}

/* ---------------- 执行（raw → module blob → 串口发射） ---------------- */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function executeItem(item: HistoryItem) {
  if (!hwStore.connected) {
    ElMessage.warning('未连接硬件，无法发射');
    return;
  }
  if (item.executing) return;
  item.executing = true;
  for (let i = 0; i < item.commands.length; i++) {
    const cmd = item.commands[i];
    const r = item.results[i];
    if (!cmd || !r) continue;
    const key = r.key;
    if (!key) {
      r.status = 'notfound';
      r.detail = cmd.action === 'unknown' ? '无法识别的动作' : '该动作暂无对应按键码';
      continue;
    }
    const entry = findEntry(cmd, key);
    if (!entry) {
      r.status = 'notfound';
      r.detail = '未找到匹配码';
      continue;
    }
    try {
      const hex = convert(entry.pulses.join(' '), 'raw', 'module');
      const blob = hex
        .trim()
        .split(/\s+/)
        .map((h) => parseInt(h, 16));
      await hw.transmitBlob(blob);
      hwStore.incTx();
      r.status = 'ok';
      r.detail = `${entry.brand} ${entry.deviceTypeName} · ${entry.keyName}`;
    } catch (e) {
      r.status = 'error';
      r.detail = e instanceof Error ? e.message : String(e);
    }
    if (i < item.commands.length - 1) await sleep(150); // 组合指令按序执行，留间隔
  }
  item.executing = false;
}

/* ---------------- 手动输入（降级 / 调试用） ---------------- */
const manualText = ref('');

function parseManual() {
  const t = manualText.value.trim();
  if (!t) return;
  processText(t, false);
  manualText.value = '';
}
</script>

<template>
  <div class="voice-view">
    <el-row :gutter="16">
      <!-- 唤醒与识别 -->
      <el-col :span="10">
        <el-card shadow="never" class="ctl-card">
          <template #header>
            <div class="card-header">
              <span>语音唤醒</span>
              <el-switch
                v-model="settings.voice.enabled"
                :disabled="!speechSupported"
                @change="onWakeToggle"
              />
            </div>
          </template>

          <el-alert
            v-if="!speechSupported"
            type="warning"
            :closable="false"
            show-icon
            class="speech-alert"
            title="当前环境不支持 Web Speech API"
            description="已降级为手动输入模式，可在右侧文本框输入指令，走同一套解析与执行流程。"
          />

          <div class="wake-row">
            <span class="text-secondary">唤醒词</span>
            <el-tag effect="plain">{{ settings.voice.wakeWord || '小控' }}</el-tag>
            <span class="text-secondary wake-tip">说「{{ settings.voice.wakeWord || '小控' }} + 指令」触发，如「{{ settings.voice.wakeWord || '小控' }}，打开空调」</span>
          </div>

          <div class="status-row">
            <span class="light" :class="`light-${status}`" />
            <span class="status-text">{{ STATUS_TEXT[status] }}</span>
          </div>

          <div class="interim-box mono">
            {{ interimText || (speechSupported && settings.voice.enabled ? '等待语音输入…' : '未开启聆听') }}
          </div>
        </el-card>
      </el-col>

      <!-- 上下文 -->
      <el-col :span="7">
        <el-card shadow="never" class="ctl-card">
          <template #header>
            <div class="card-header">
              <span>指令上下文</span>
              <el-button size="small" text type="danger" @click="clearCtx">清除</el-button>
            </div>
          </template>
          <div class="kv"><span class="k text-secondary">当前品类</span><span class="v">{{ ctxDeviceText }}</span></div>
          <div class="kv"><span class="k text-secondary">当前品牌</span><span class="v">{{ ctxBrandText }}</span></div>
          <div class="ctx-tip text-secondary">
            省略主语的指令（如「音量调大一点」）会自动继承上文的品类与品牌。
          </div>
        </el-card>
      </el-col>

      <!-- 手动输入 -->
      <el-col :span="7">
        <el-card shadow="never" class="ctl-card">
          <template #header><span>手动输入指令</span></template>
          <el-input
            v-model="manualText"
            type="textarea"
            :rows="4"
            placeholder="例如：小控，打开格力空调，然后调到 26 度"
            @keydown.enter.exact.prevent="parseManual"
          />
          <div class="manual-actions">
            <el-button type="primary" size="small" :disabled="!manualText.trim()" @click="parseManual">
              解析指令
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 指令历史 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>指令历史</span>
          <el-tag v-if="!hwStore.connected" size="small" type="info" effect="plain">
            未连接硬件：执行不可用，解析演示不受影响
          </el-tag>
        </div>
      </template>

      <el-empty v-if="!history.length" description="暂无指令，说一句话或手动输入试试" :image-size="80" />

      <div v-for="item in history" :key="item.id" class="hist-item">
        <div class="hist-head">
          <span class="hist-time mono text-secondary">{{ item.time }}</span>
          <span class="hist-raw">{{ item.raw }}</span>
          <div class="spacer" />
          <el-button
            size="small"
            type="primary"
            plain
            :disabled="!hwStore.connected || item.executing"
            :title="hwStore.connected ? '' : '未连接硬件'"
            @click="executeItem(item)"
          >
            {{ item.executing ? '执行中…' : '执行' }}
          </el-button>
        </div>
        <div class="hist-cmds">
          <div v-for="(c, i) in item.commands" :key="i" class="cmd-line">
            <div class="cmd-struct">
              <el-tag size="small" effect="plain">{{ deviceName(c.deviceType) }}</el-tag>
              <el-tag v-if="c.brand" size="small" type="info" effect="plain">{{ c.brand }}</el-tag>
              <span class="cmd-action">{{ actionName(c.action) }}</span>
              <el-tag v-if="c.value !== undefined" size="small" type="warning" effect="plain">
                {{ c.value }}
              </el-tag>
            </div>
            <div v-if="item.results[i]" class="cmd-status" :class="`st-${item.results[i].status}`">
              <el-icon :size="14"><component :is="statusIcon(item.results[i].status)" /></el-icon>
              <span>{{ item.results[i].detail || STATUS_LABEL[item.results[i].status] }}</span>
            </div>
          </div>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.voice-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ctl-card {
  min-height: 240px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.speech-alert {
  margin-bottom: 12px;
}

.wake-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;

  .wake-tip {
    font-size: 12px;
  }
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;

  .status-text {
    font-weight: 600;
  }
}

/* 识别状态灯 */
.light {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--el-color-info);
  flex-shrink: 0;

  &.light-listening {
    background: var(--el-color-success);
  }

  &.light-recognizing {
    background: var(--el-color-warning);
  }

  &.light-awake {
    background: var(--el-color-primary);
  }
}

.interim-box {
  min-height: 56px;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: var(--app-radius);
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.kv {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;

  .v {
    font-weight: 600;
  }
}

.ctx-tip {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.6;
}

.manual-actions {
  margin-top: 10px;
  text-align: right;
}

.spacer {
  flex: 1;
}

.hist-item {
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  padding: 10px 12px;
  margin-bottom: 10px;

  &:last-child {
    margin-bottom: 0;
  }
}

.hist-head {
  display: flex;
  align-items: center;
  gap: 10px;

  .hist-time {
    font-size: 12px;
    flex-shrink: 0;
  }

  .hist-raw {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.hist-cmds {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cmd-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.cmd-struct {
  display: flex;
  align-items: center;
  gap: 6px;

  .cmd-action {
    font-size: 13px;
  }
}

.cmd-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;

  &.st-ok {
    color: var(--el-color-success);
  }

  &.st-notfound,
  &.st-nohw {
    color: var(--el-color-warning);
  }

  &.st-error {
    color: var(--el-color-danger);
  }

  &.st-pending {
    color: var(--el-text-color-secondary);
  }
}
</style>
