/** Tauri 硬件指令封装 + 事件桥（契约稳定，页面/ store 只调这里） */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { HwCaps, PortInfo, IrBlob } from '../types/ir';

export interface IrEventPayload {
  kind: 'learned' | 'ack' | 'error' | 'raw';
  blob?: number[];
  code?: number;
  message?: string;
  bytes?: number[];
}

export const hw = {
  listSerialPorts: () => invoke<PortInfo[]>('list_serial_ports'),
  detect: (portName?: string, baud?: number) =>
    invoke<HwCaps>('ir_detect', { portName, baud }),
  open: (portName: string, baud: number) => invoke<void>('ir_open', { portName, baud }),
  close: () => invoke<void>('ir_close'),
  test: () => invoke<boolean>('ir_test'),
  learnStart: (slot?: number) => invoke<void>('ir_learn_start', { slot }),
  learnCancel: () => invoke<void>('ir_learn_cancel'),
  transmitSlot: (slot: number) => invoke<void>('ir_transmit_slot', { slot }),
  readSlot: (slot: number) => invoke<IrBlob>('ir_read_slot', { slot }),
  writeSlot: (slot: number, blob: IrBlob) => invoke<void>('ir_write_slot', { slot, blob }),
  transmitBlob: (blob: IrBlob) => invoke<void>('ir_transmit_blob', { blob }),
  eraseAll: () => invoke<void>('ir_erase_all'),
  sceneSet: (no: number, delayS: number, intervalS: number, slots: number[]) =>
    invoke<void>('ir_scene_set', { no, delayS, intervalS, slots }),
  sceneQuery: (no: number) => invoke<number[]>('ir_scene_query', { no }),
  sceneSetPowerOn: (no: number) => invoke<void>('ir_scene_set_power_on', { no }),
  scenePowerOnQuery: () => invoke<number>('ir_scene_power_on_query'),
  sceneRun: (no: number) => invoke<void>('ir_scene_run', { no }),
  sceneStop: () => invoke<void>('ir_scene_stop'),
};

export function onIrEvent(cb: (p: IrEventPayload) => void): Promise<UnlistenFn> {
  return listen<IrEventPayload>('ir:event', (e) => cb(e.payload));
}
