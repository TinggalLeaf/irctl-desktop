<script setup lang="ts">
/**
 * 实时红外页：EB 连续学习循环捕获全部信号，不做频段/协议过滤。
 * 载波频段折线 + 帧时长/脉冲分布/协议饼图 + 事件表；支持清空后重新捕获。
 */
import { computed, onUnmounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useHardwareStore } from '../stores/hardware';
import { useRealtimeStore, type RtSample } from '../stores/realtime';
import RealtimePanel from '../components/RealtimePanel.vue';

defineOptions({ name: 'RealtimeView' });

const hwStore = useHardwareStore();
const rt = useRealtimeStore();

const hwReady = computed(() => hwStore.connected);
const busy = ref(false);

async function startCapture() {
  busy.value = true;
  try {
    await rt.start();
  } catch (e) {
    ElMessage.error(`启动捕获失败：${typeof e === 'string' ? e : (e as Error)?.message}`);
  } finally {
    busy.value = false;
  }
}

async function stopCapture() {
  await rt.stop();
}

/** 清空全部数据并重新捕获 */
async function clearAndRestart() {
  const wasCapturing = rt.capturing;
  if (wasCapturing) await rt.stop();
  rt.clear();
  await startCapture();
  ElMessage.success('已清空，重新开始捕获');
}

function timeStr(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

const selected = ref<RtSample | null>(null);

onUnmounted(() => {
  // 离开页面时停止捕获：模块在学习中只认 E2，挂着捕获会阻塞发射等指令
  if (rt.capturing) void rt.stop();
});
</script>

<template>
  <div class="realtime-view">
    <el-alert
      v-if="!hwReady"
      type="warning"
      :closable="false"
      title="红外模块未连接，请先到仪表盘检测设备"
      class="mb12"
    />

    <div class="toolbar">
      <el-button
        v-if="!rt.capturing"
        type="primary"
        :loading="busy"
        :disabled="!hwReady"
        @click="startCapture"
      >
        开始捕获
      </el-button>
      <el-button v-else type="danger" @click="stopCapture">停止捕获</el-button>
      <el-button :disabled="!hwReady && !rt.samples.length" @click="clearAndRestart">
        清空并重新捕获
      </el-button>
      <el-button :disabled="!rt.samples.length" @click="rt.clear()">仅清空数据</el-button>
      <el-tag v-if="rt.capturing" type="success" effect="dark">捕获中，请对准接收头按遥控器</el-tag>
      <span v-if="rt.lastError" class="err">{{ rt.lastError }}</span>
    </div>

    <div class="stat-row">
      <el-card shadow="never" class="stat">
        <div class="num">{{ rt.totalCount }}</div>
        <div class="label">捕获总数</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="num">{{ rt.latest ? (rt.latest.carrierHz / 1000).toFixed(2) + ' kHz' : '—' }}</div>
        <div class="label">最新载波</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="num">{{ rt.latest?.protocol ?? '—' }}</div>
        <div class="label">最新协议</div>
      </el-card>
      <el-card shadow="never" class="stat">
        <div class="num">{{ rt.ratePerMin }}</div>
        <div class="label">速率（次/分钟）</div>
      </el-card>
    </div>

    <RealtimePanel :samples="rt.samples" />

    <el-table
      :data="[...rt.samples].reverse()"
      size="small"
      max-height="320"
      class="mt12"
      empty-text="暂无捕获数据，点击「开始捕获」后按遥控器按键"
      @row-click="(row: RtSample) => (selected = row)"
    >
      <el-table-column label="时间" width="100">
        <template #default="{ row }">{{ timeStr(row.ts) }}</template>
      </el-table-column>
      <el-table-column prop="protocol" label="协议" width="110" />
      <el-table-column label="载波" width="90">
        <template #default="{ row }">{{ (row.carrierHz / 1000).toFixed(2) }}k</template>
      </el-table-column>
      <el-table-column prop="pulseCount" label="脉冲数" width="80" />
      <el-table-column label="帧时长" width="90">
        <template #default="{ row }">{{ (row.durationUs / 1000).toFixed(1) }}ms</template>
      </el-table-column>
      <el-table-column label="地址/命令" width="110">
        <template #default="{ row }">
          <span v-if="row.address !== undefined">
            {{ row.address.toString(16).toUpperCase() }}/{{ row.command?.toString(16).toUpperCase() }}
          </span>
          <span v-else>—</span>
        </template>
      </el-table-column>
      <el-table-column label="Blob（前 24 字节）" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ row.hex.split(' ').slice(0, 24).join(' ') }}…</template>
      </el-table-column>
    </el-table>

    <el-input
      v-if="selected"
      :model-value="selected.hex"
      type="textarea"
      :rows="3"
      readonly
      class="mt12"
    />
  </div>
</template>

<style scoped lang="scss">
.realtime-view {
  padding: 4px;
}
.mb12 {
  margin-bottom: 12px;
}
.mt12 {
  margin-top: 12px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  .err {
    color: var(--el-color-danger);
    font-size: 12px;
  }
}
.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
  .stat {
    text-align: center;
    .num {
      font-size: 20px;
      font-weight: 600;
    }
    .label {
      font-size: 12px;
      color: var(--el-text-color-secondary);
      margin-top: 4px;
    }
  }
}
</style>
