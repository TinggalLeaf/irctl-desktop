<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useHardwareStore } from './stores/hardware';
import { useSettingsStore, type ThemeMode } from './stores/settings';
import { useLibraryStore } from './stores/library';
import {
  CODELIB_VERSION,
  loadOfflineLibrary,
  listBrands,
  listDeviceTypes,
} from './lib/codelib';

const router = useRouter();
const route = useRoute();
const hw = useHardwareStore();
const settings = useSettingsStore();
const library = useLibraryStore();

// 启动即回填码库统计，看板无需先打开码库页
onMounted(() => {
  const entries = loadOfflineLibrary();
  library.setInfo(`${CODELIB_VERSION}（离线内置）`, {
    total: entries.length,
    brands: listBrands().length,
    types: listDeviceTypes().length,
  });
});

const collapsed = ref(false);

const menuItems = computed(() =>
  router.options.routes.filter((r) => r.meta?.title),
);

const themeOrder: ThemeMode[] = ['light', 'dark', 'oled'];
const themeIcon = computed(() => {
  if (settings.theme.mode === 'light') return 'Sunny';
  if (settings.theme.mode === 'dark') return 'Moon';
  return 'MoonNight';
});
const themeLabel = computed(() => {
  if (settings.theme.mode === 'light') return '亮色';
  if (settings.theme.mode === 'dark') return '暗色';
  return 'OLED';
});

function cycleTheme() {
  const idx = themeOrder.indexOf(settings.theme.mode);
  settings.theme.mode = themeOrder[(idx + 1) % themeOrder.length];
}

function goSettings() {
  void router.push('/settings');
}
</script>

<template>
  <el-container class="app-shell">
    <el-aside :width="collapsed ? '64px' : '208px'" class="app-aside">
      <div class="app-logo" :class="{ collapsed }">
        <el-icon :size="22" class="logo-icon"><Connection /></el-icon>
        <span v-show="!collapsed" class="logo-text">红外工具箱</span>
      </div>

      <el-menu
        :default-active="route.path"
        :collapse="collapsed"
        router
        class="app-menu"
      >
        <el-menu-item
          v-for="item in menuItems"
          :key="item.path"
          :index="item.path"
          :disabled="Boolean(item.meta?.needHw) && !hw.connected"
        >
          <el-icon><component :is="item.meta?.icon" /></el-icon>
          <template #title>
            <span>{{ item.meta?.title }}</span>
            <el-tag
              v-if="item.meta?.needHw && !hw.connected"
              size="small"
              type="info"
              effect="plain"
              class="need-hw-tag"
            >需硬件</el-tag>
          </template>
        </el-menu-item>
      </el-menu>

      <div class="aside-footer">
        <el-button text class="collapse-btn" @click="collapsed = !collapsed">
          <el-icon>
            <Fold v-if="!collapsed" />
            <Expand v-else />
          </el-icon>
          <span v-show="!collapsed" style="margin-left: 6px">收起</span>
        </el-button>
      </div>
    </el-aside>

    <el-container class="app-body">
      <el-header class="app-header" height="56px">
        <div class="page-title">{{ route.meta.title }}</div>
        <div class="header-right">
          <el-tooltip content="硬件状态，点击前往设置" placement="bottom">
            <div class="hw-chip" :class="{ on: hw.connected }" @click="goSettings">
              <span class="hw-dot" />
              <span v-if="hw.connected" class="mono">{{ hw.port }} · {{ hw.baud }}</span>
              <span v-else>未连接</span>
            </div>
          </el-tooltip>
          <el-tooltip :content="`主题：${themeLabel}（点击切换）`" placement="bottom">
            <el-button circle @click="cycleTheme">
              <el-icon><component :is="themeIcon" /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </el-header>

      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped lang="scss">
.app-shell {
  height: 100%;
}

.app-aside {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color);
  transition: width var(--app-anim-duration) ease;
  overflow: hidden;
}

.app-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 18px;
  flex-shrink: 0;

  &.collapsed {
    padding: 0;
    justify-content: center;
  }

  .logo-icon {
    color: var(--el-color-primary);
    flex-shrink: 0;
  }

  .logo-text {
    font-size: 16px;
    font-weight: 600;
    white-space: nowrap;
  }
}

.app-menu {
  flex: 1;
  border-right: none;

  &:not(.el-menu--collapse) {
    width: 100%;
  }
}

.need-hw-tag {
  margin-left: 8px;
  transform: scale(0.85);
}

.aside-footer {
  flex-shrink: 0;
  padding: 8px;
  border-top: 1px solid var(--el-border-color-light);

  .collapse-btn {
    width: 100%;
    justify-content: flex-start;
  }
}

.app-body {
  min-width: 0;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color);
  padding: 0 20px;

  .page-title {
    font-size: 16px;
    font-weight: 600;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
}

.hw-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 13px;
  cursor: pointer;
  color: var(--el-text-color-secondary);
  background-color: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-light);

  .hw-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--el-text-color-placeholder);
  }

  &.on {
    color: var(--el-color-success);
    border-color: var(--el-color-success-light-5);
    background-color: var(--el-color-success-light-9);

    .hw-dot {
      background-color: var(--el-color-success);
      box-shadow: 0 0 6px var(--el-color-success);
    }
  }
}

.app-main {
  padding: 20px;
  overflow-y: auto;
}
</style>
