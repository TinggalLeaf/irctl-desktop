/** 全局设置 store：全部 localStorage 持久化（key 前缀 irctl:），主题实时写入 DOM */
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

export type ThemeMode = 'light' | 'dark' | 'oled';

export interface PaletteDef {
  key: string;
  name: string;
  color: string;
}

/** 7 套预设色板 */
export const PALETTES: PaletteDef[] = [
  { key: 'aurora', name: '极光蓝', color: '#3a86ff' },
  { key: 'dusk', name: '暮山紫', color: '#7c5cfc' },
  { key: 'jade', name: '翡翠绿', color: '#00a870' },
  { key: 'danxia', name: '丹霞橙', color: '#f2701e' },
  { key: 'sakura', name: '樱花粉', color: '#ec6aa9' },
  { key: 'graphite', name: '石墨灰', color: '#5c6b7a' },
  { key: 'crimson', name: '中国红', color: '#d9363e' },
];

export interface SerialSettings {
  port: string;
  baud: number;
  autoReconnect: boolean;
}
export interface TransmitSettings {
  repeatCount: number;
  intervalMs: number;
}
export interface ReceiveSettings {
  /** 解码容差 % */
  tolerance: number;
  /** 毛刺过滤 µs */
  glitchFilterUs: number;
  /** 学习模式：software=EB 出码+软件解码（默认）；hardware=E0 学习入模块槽位 */
  learnMode: 'software' | 'hardware';
}
export interface ThemeSettings {
  mode: ThemeMode;
  /** PALETTES key 或 'custom' */
  palette: string;
  customColor: string;
  /** 0-16 */
  radius: number;
  /** 12-18 */
  fontSize: number;
  /** 0.5-2 倍速 */
  animSpeed: number;
}
export interface CodelibSettings {
  onlineEnabled: boolean;
  /** 缓存 TTL（秒） */
  cacheTtl: number;
}
export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}
export interface VoiceSettings {
  enabled: boolean;
  wakeWord: string;
}

export interface SettingsState {
  serial: SerialSettings;
  transmit: TransmitSettings;
  receive: ReceiveSettings;
  theme: ThemeSettings;
  codelib: CodelibSettings;
  ai: AiSettings;
  voice: VoiceSettings;
}

const STORAGE_KEY = 'irctl:settings';
/** 动画基准时长（秒），实际时长 = BASE / animSpeed */
const ANIM_BASE_S = 0.3;

function defaults(): SettingsState {
  return {
    serial: { port: '', baud: 9600, autoReconnect: true },
    transmit: { repeatCount: 1, intervalMs: 100 },
    receive: { tolerance: 25, glitchFilterUs: 80, learnMode: 'software' },
    theme: {
      mode: 'light',
      palette: 'aurora',
      customColor: '#3a86ff',
      radius: 8,
      fontSize: 14,
      animSpeed: 1,
    },
    codelib: { onlineEnabled: true, cacheTtl: 86400 },
    ai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
    voice: { enabled: false, wakeWord: '小控' },
  };
}

function load(): SettingsState {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<SettingsState>;
    return {
      serial: { ...d.serial, ...s.serial },
      transmit: { ...d.transmit, ...s.transmit },
      receive: { ...d.receive, ...s.receive },
      theme: { ...d.theme, ...s.theme },
      codelib: { ...d.codelib, ...s.codelib },
      ai: { ...d.ai, ...s.ai },
      voice: { ...d.voice, ...s.voice },
    };
  } catch {
    return d;
  }
}

// ---------- Monet 风格取色工具 ----------
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** base 向 target 混入 weightPct%（与 Element Plus 的 mix() 公式一致） */
function mixHex(base: string, target: string, weightPct: number): string {
  const [br, bg, bb] = hexToRgb(base);
  const [tr, tg, tb] = hexToRgb(target);
  const w = weightPct / 100;
  return rgbToHex(br * (1 - w) + tr * w, bg * (1 - w) + tg * w, bb * (1 - w) + tb * w);
}

export const useSettingsStore = defineStore('settings', () => {
  const state = ref<SettingsState>(load());

  // 分区快捷引用（模板里直接用 settings.serial.port 等）
  const serial = ref(state.value.serial);
  const transmit = ref(state.value.transmit);
  const receive = ref(state.value.receive);
  const theme = ref(state.value.theme);
  const codelib = ref(state.value.codelib);
  const ai = ref(state.value.ai);
  const voice = ref(state.value.voice);

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
    } catch {
      /* 存储满等异常静默 */
    }
  }

  /** 当前主色（预设色板或自定义） */
  function primaryColor(): string {
    if (theme.value.palette === 'custom') return theme.value.customColor;
    return PALETTES.find((p) => p.key === theme.value.palette)?.color ?? PALETTES[0].color;
  }

  /** 把主题写入 DOM：class + Element Plus 主色派生 + 应用级变量，即时生效 */
  function applyTheme() {
    const root = document.documentElement;
    const t = theme.value;

    root.classList.toggle('dark', t.mode !== 'light');
    root.classList.toggle('oled', t.mode === 'oled');

    const primary = primaryColor();
    const set = (k: string, v: string) => root.style.setProperty(k, v);
    set('--el-color-primary', primary);
    for (const i of [3, 5, 7, 8, 9] as const) {
      set(`--el-color-primary-light-${i}`, mixHex(primary, '#ffffff', i * 10));
    }
    set('--el-color-primary-dark-2', mixHex(primary, '#000000', 20));

    set('--app-radius', `${t.radius}px`);
    set('--app-font-size', `${t.fontSize}px`);
    const dur = Math.round((ANIM_BASE_S / Math.max(0.1, t.animSpeed)) * 1000) / 1000;
    set('--app-anim-duration', `${dur}s`);
  }

  // 任一设置变化：同步回 state、持久化；主题变化：立即应用
  watch(
    [serial, transmit, receive, theme, codelib, ai, voice],
    () => {
      state.value = {
        serial: serial.value,
        transmit: transmit.value,
        receive: receive.value,
        theme: theme.value,
        codelib: codelib.value,
        ai: ai.value,
        voice: voice.value,
      };
      persist();
      applyTheme();
    },
    { deep: true },
  );

  return {
    serial,
    transmit,
    receive,
    theme,
    codelib,
    ai,
    voice,
    applyTheme,
    primaryColor,
  };
});
