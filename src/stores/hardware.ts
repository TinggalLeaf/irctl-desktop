/** 硬件状态 store：连接/能力/今日发射计数 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { hw } from '../lib/hardware';
import type { HwCaps } from '../types/ir';
import { useSettingsStore } from './settings';

function todayKey(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `irctl:txcount:${ymd}`;
}

export const useHardwareStore = defineStore('hardware', () => {
  const caps = ref<HwCaps | null>(null);
  const connected = ref(false);
  const port = ref('');
  const baud = ref(9600);
  const detecting = ref(false);
  const lastError = ref('');

  /** 探测设备（默认用设置里的端口/波特率）；成功视为已连接 */
  async function detect(portName?: string, b?: number): Promise<HwCaps | null> {
    const settings = useSettingsStore();
    detecting.value = true;
    lastError.value = '';
    try {
      // 串口被占用时探测会打不开端口，先释放已有连接
      if (connected.value) {
        try {
          await hw.close();
        } catch {
          /* ignore */
        }
        connected.value = false;
      }
      const c = await hw.detect(portName || settings.serial.port || undefined, b ?? settings.serial.baud);
      caps.value = c;
      port.value = c.port;
      baud.value = c.baud;
      // 探测只做了瞬态握手，端口并未保持打开；立即打开串口使学习/发射等指令可用
      try {
        await hw.open(c.port, c.baud);
        connected.value = true;
      } catch (e) {
        connected.value = false;
        lastError.value = typeof e === 'string' ? e : (e as Error)?.message ?? '打开串口失败';
      }
      return c;
    } catch (e) {
      caps.value = null;
      connected.value = false;
      lastError.value = typeof e === 'string' ? e : (e as Error)?.message ?? '探测失败';
      return null;
    } finally {
      detecting.value = false;
    }
  }

  async function open(portName?: string, b?: number): Promise<boolean> {
    const settings = useSettingsStore();
    const p = portName || settings.serial.port || port.value;
    const bd = b ?? settings.serial.baud ?? baud.value;
    if (!p) return false;
    try {
      await hw.open(p, bd);
      port.value = p;
      baud.value = bd;
      connected.value = true;
      return true;
    } catch (e) {
      connected.value = false;
      lastError.value = typeof e === 'string' ? e : (e as Error)?.message ?? '打开串口失败';
      return false;
    }
  }

  async function close(): Promise<void> {
    try {
      await hw.close();
    } finally {
      connected.value = false;
    }
  }

  async function test(): Promise<boolean> {
    try {
      return await hw.test();
    } catch {
      return false;
    }
  }

  // ---------- 今日发射次数（按日持久化） ----------
  const todayTxCount = ref(Number(localStorage.getItem(todayKey()) ?? 0) || 0);

  function incTx(n = 1) {
    const key = todayKey();
    // 跨天时重新读取当日计数
    todayTxCount.value = (Number(localStorage.getItem(key) ?? 0) || 0) + n;
    try {
      localStorage.setItem(key, String(todayTxCount.value));
    } catch {
      /* ignore */
    }
  }

  return {
    caps,
    connected,
    port,
    baud,
    detecting,
    lastError,
    detect,
    open,
    close,
    test,
    todayTxCount,
    incTx,
  };
});
