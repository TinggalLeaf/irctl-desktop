/** 码库 store：版本/条目统计/在线状态（codelib 库模块写好后通过 setInfo/setOnline 回填） */
import { defineStore } from 'pinia';
import { ref } from 'vue';

const KEY_VERSION = 'irctl:codelib:version';
const KEY_TOTAL = 'irctl:codelib:total';
const KEY_BRANDS = 'irctl:codelib:brands';
const KEY_TYPES = 'irctl:codelib:types';
const CACHE_PREFIX = 'irctl:codelib:cache';

function loadNum(key: string): number {
  return Number(localStorage.getItem(key) ?? 0) || 0;
}

export const useLibraryStore = defineStore('library', () => {
  const version = ref(localStorage.getItem(KEY_VERSION) ?? '1.0.0（离线内置）');
  const totalEntries = ref(loadNum(KEY_TOTAL));
  const brandCount = ref(loadNum(KEY_BRANDS));
  const deviceTypeCount = ref(loadNum(KEY_TYPES));
  /** 在线码库当前是否可用（由 codelib 模块探测后回填） */
  const online = ref(false);

  function setInfo(v: string, stats: { total: number; brands: number; types: number }) {
    version.value = v;
    totalEntries.value = stats.total;
    brandCount.value = stats.brands;
    deviceTypeCount.value = stats.types;
    try {
      localStorage.setItem(KEY_VERSION, v);
      localStorage.setItem(KEY_TOTAL, String(stats.total));
      localStorage.setItem(KEY_BRANDS, String(stats.brands));
      localStorage.setItem(KEY_TYPES, String(stats.types));
    } catch {
      /* ignore */
    }
  }

  function setOnline(v: boolean) {
    online.value = v;
  }

  /** 清理在线码库缓存（irctl:codelib:cache*） */
  function clearCache(): number {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  }

  return {
    version,
    totalEntries,
    brandCount,
    deviceTypeCount,
    online,
    setInfo,
    setOnline,
    clearCache,
  };
});
