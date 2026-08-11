<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onIrEvent, type IrEventPayload } from '../lib/hardware';
import { useHardwareStore } from '../stores/hardware';
import { useSettingsStore } from '../stores/settings';
import { usePresetsStore } from '../stores/presets';
import { useLibraryStore } from '../stores/library';

const router = useRouter();
const hw = useHardwareStore();
const settings = useSettingsStore();
const presets = usePresetsStore();
const library = useLibraryStore();

// 首启动自动探测
onMounted(() => {
  if (!hw.caps && !hw.detecting && !hw.connected) void hw.detect();
});

// ---------- 快捷入口 ----------
const entries = router.options.routes.filter((r) => r.meta?.title);

function go(path: string, needHw?: boolean) {
  if (needHw && !hw.connected) return;
  void router.push(path);
}

// ---------- 信号检测器 ----------
interface EvItem {
  time: string;
  kind: IrEventPayload['kind'];
  text: string;
}

const events = ref<EvItem[]>([]);
let unlisten: UnlistenFn | null = null;

function describe(p: IrEventPayload): string {
  switch (p.kind) {
    case 'learned':
      return `学习成功，收到 ${p.blob?.length ?? 0} 字节码库数据`;
    case 'ack':
      return `指令应答 0x${(p.code ?? 0).toString(16).toUpperCase().padStart(2, '0')}`;
    case 'error':
      return `错误：${p.message ?? '未知错误'}`;
    case 'raw':
      return `原始返回 ${p.bytes?.length ?? 0} 字节`;
  }
}

function evTagType(kind: IrEventPayload['kind']): 'success' | 'info' | 'danger' | 'warning' {
  if (kind === 'learned') return 'success';
  if (kind === 'ack') return 'info';
  if (kind === 'error') return 'danger';
  return 'warning';
}

function evKindName(kind: IrEventPayload['kind']): string {
  return { learned: '学习', ack: '应答', error: '错误', raw: '原始' }[kind];
}

onMounted(async () => {
  unlisten = await onIrEvent((p) => {
    events.value.unshift({
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      kind: p.kind,
      text: describe(p),
    });
    if (events.value.length > 50) events.value.pop();
  });
});

onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <div class="dashboard">
    <el-row :gutter="16">
      <!-- 硬件状态卡 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>硬件状态</span>
              <el-button
                v-if="!hw.connected"
                size="small"
                type="primary"
                :loading="hw.detecting"
                @click="hw.detect()"
              >重新检测</el-button>
              <el-tag v-else type="success" size="small">已连接</el-tag>
            </div>
          </template>
          <template v-if="hw.caps">
            <div class="kv"><span class="k">端口</span><span class="v mono">{{ hw.caps.port }}</span></div>
            <div class="kv"><span class="k">波特率</span><span class="v mono">{{ hw.caps.baud }}</span></div>
            <div class="kv"><span class="k">载波</span><span class="v mono">{{ hw.caps.carrierHz / 1000 }} kHz</span></div>
            <div class="kv"><span class="k">存储槽</span><span class="v mono">{{ hw.caps.slots }} 个</span></div>
            <div class="kv"><span class="k">发射点数</span><span class="v mono">{{ hw.caps.emitters }}</span></div>
          </template>
          <div v-else class="no-device">
            <el-icon :size="28"><WarningFilled /></el-icon>
            <p>{{ hw.detecting ? '正在检测…' : '未检测到设备' }}</p>
            <p v-if="hw.lastError && !hw.detecting" class="err">{{ hw.lastError }}</p>
          </div>
        </el-card>
      </el-col>

      <!-- 发射功率档卡 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <template #header><span>发射功率档</span></template>
          <div class="big-num">{{ settings.transmit.repeatCount }}<span class="unit">档</span></div>
          <div class="text-secondary">
            软件层连发 {{ settings.transmit.repeatCount }} 次 · 间隔 {{ settings.transmit.intervalMs }} ms
          </div>
          <div class="card-foot">
            <el-button text type="primary" size="small" @click="router.push('/settings')">前往设置</el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 今日发射次数卡 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <template #header><span>今日发射次数</span></template>
          <div class="big-num">{{ hw.todayTxCount }}<span class="unit">次</span></div>
          <div class="text-secondary">按自然日统计，本地持久化</div>
        </el-card>
      </el-col>

      <!-- 预设统计卡 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <template #header><span>预设统计</span></template>
          <div class="big-num">{{ presets.stats.total }}<span class="unit">个</span></div>
          <div class="text-secondary">
            {{ presets.stats.categories }} 个分类 · {{ presets.stats.groups }} 个分组 · 累计使用 {{ presets.stats.totalUse }} 次
          </div>
          <div class="card-foot">
            <el-button text type="primary" size="small" @click="router.push('/transmit')">管理预设</el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 码库版本卡 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <template #header>
            <div class="card-header">
              <span>码库</span>
              <el-tag :type="library.online ? 'success' : 'info'" size="small">
                {{ library.online ? '在线可用' : '离线' }}
              </el-tag>
            </div>
          </template>
          <div class="lib-version mono">{{ library.version }}</div>
          <div class="text-secondary">
            {{ library.totalEntries }} 条码 · {{ library.brandCount }} 品牌 · {{ library.deviceTypeCount }} 类设备
          </div>
          <div class="card-foot">
            <el-button text type="primary" size="small" @click="router.push('/library')">打开码库</el-button>
          </div>
        </el-card>
      </el-col>

      <!-- 信号检测器 -->
      <el-col :span="8">
        <el-card shadow="never" class="stat-card monitor-card">
          <template #header>
            <div class="card-header">
              <span>信号检测器</span>
              <el-tag size="small" :type="hw.connected ? 'success' : 'info'" effect="plain">
                {{ hw.connected ? '监听中' : '未连接' }}
              </el-tag>
            </div>
          </template>
          <div v-if="events.length" class="ev-list">
            <div v-for="(e, i) in events" :key="i" class="ev-item">
              <span class="ev-time mono">{{ e.time }}</span>
              <el-tag size="small" :type="evTagType(e.kind)" effect="plain">{{ evKindName(e.kind) }}</el-tag>
              <span class="ev-text">{{ e.text }}</span>
            </div>
          </div>
          <div v-else class="ev-empty text-secondary">暂无事件，等待硬件返回…</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 快捷入口 -->
    <el-card shadow="never" class="quick-card">
      <template #header><span>快捷入口</span></template>
      <div class="quick-grid">
        <div
          v-for="e in entries"
          :key="e.path"
          class="quick-entry"
          :class="{ disabled: Boolean(e.meta?.needHw) && !hw.connected }"
          @click="go(e.path, e.meta?.needHw)"
        >
          <el-icon :size="26"><component :is="e.meta?.icon" /></el-icon>
          <span class="qe-name">{{ e.meta?.title }}</span>
          <el-tag
            v-if="e.meta?.needHw && !hw.connected"
            size="small"
            type="info"
            effect="plain"
          >需硬件</el-tag>
        </div>
      </div>
    </el-card>
  </div>
</template>

<style scoped lang="scss">
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stat-card {
  min-height: 190px;
  margin-bottom: 16px;

  :deep(.el-card__header) {
    font-weight: 600;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kv {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;

  .k {
    color: var(--el-text-color-secondary);
  }
}

.no-device {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 0;
  color: var(--el-text-color-secondary);

  p {
    margin: 0;
  }

  .err {
    font-size: 12px;
    color: var(--el-color-danger);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.big-num {
  font-size: 38px;
  font-weight: 700;
  color: var(--el-color-primary);
  line-height: 1.2;
  margin-bottom: 6px;

  .unit {
    font-size: 14px;
    font-weight: 400;
    margin-left: 6px;
    color: var(--el-text-color-secondary);
  }
}

.lib-version {
  font-size: 20px;
  font-weight: 600;
  color: var(--el-color-primary);
  margin-bottom: 8px;
}

.card-foot {
  margin-top: 8px;
  text-align: right;
}

.monitor-card {
  .ev-list {
    max-height: 132px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ev-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;

    .ev-time {
      color: var(--el-text-color-secondary);
      flex-shrink: 0;
    }

    .ev-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .ev-empty {
    text-align: center;
    padding: 24px 0;
    font-size: 13px;
  }
}

.quick-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.quick-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0 16px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--app-radius);
  cursor: pointer;
  color: var(--el-text-color-primary);

  .el-icon {
    color: var(--el-color-primary);
  }

  .qe-name {
    font-size: 14px;
  }

  &:hover {
    border-color: var(--el-color-primary);
    background-color: var(--el-color-primary-light-9);
  }

  &.disabled {
    cursor: not-allowed;
    opacity: 0.45;

    &:hover {
      border-color: var(--el-border-color-light);
      background-color: transparent;
    }

    .el-icon {
      color: var(--el-text-color-placeholder);
    }
  }
}
</style>
