/** 预设 store：CRUD + 搜索/分类/分组过滤 + localStorage 持久化 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { Preset } from '../types/ir';

const STORAGE_KEY = 'irctl:presets';

function load(): Preset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Preset[]) : [];
  } catch {
    return [];
  }
}

export const usePresetsStore = defineStore('presets', () => {
  const presets = ref<Preset[]>(load());

  // ---------- 过滤条件 ----------
  const search = ref('');
  const category = ref('');
  const group = ref('');

  const categories = computed(() => [...new Set(presets.value.map((p) => p.category).filter(Boolean))]);
  const groups = computed(() => [...new Set(presets.value.map((p) => p.group).filter(Boolean))]);

  const filtered = computed(() => {
    const kw = search.value.trim().toLowerCase();
    return presets.value.filter((p) => {
      if (category.value && p.category !== category.value) return false;
      if (group.value && p.group !== group.value) return false;
      if (!kw) return true;
      return (
        p.name.toLowerCase().includes(kw) ||
        p.category.toLowerCase().includes(kw) ||
        p.group.toLowerCase().includes(kw) ||
        (p.protocol ?? '').toLowerCase().includes(kw)
      );
    });
  });

  // ---------- 统计（Dashboard 用） ----------
  const stats = computed(() => ({
    total: presets.value.length,
    categories: categories.value.length,
    groups: groups.value.length,
    totalUse: presets.value.reduce((s, p) => s + p.useCount, 0),
  }));

  // ---------- CRUD ----------
  function addPreset(input: Omit<Preset, 'id' | 'createdAt' | 'useCount'>): Preset {
    const p: Preset = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      useCount: 0,
    };
    presets.value.push(p);
    return p;
  }

  function updatePreset(id: string, patch: Partial<Omit<Preset, 'id'>>): boolean {
    const idx = presets.value.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    presets.value[idx] = { ...presets.value[idx], ...patch, id };
    return true;
  }

  function removePreset(id: string): boolean {
    const idx = presets.value.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    presets.value.splice(idx, 1);
    return true;
  }

  function getPreset(id: string): Preset | undefined {
    return presets.value.find((p) => p.id === id);
  }

  function incUse(id: string) {
    const p = getPreset(id);
    if (p) p.useCount += 1;
  }

  function clearFilters() {
    search.value = '';
    category.value = '';
    group.value = '';
  }

  watch(presets, (v) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, { deep: true });

  return {
    presets,
    search,
    category,
    group,
    categories,
    groups,
    filtered,
    stats,
    addPreset,
    updatePreset,
    removePreset,
    getPreset,
    incUse,
    clearFilters,
  };
});
