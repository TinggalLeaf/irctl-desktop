/** 共享类型定义 —— 所有模块统一引用，禁止修改签名（新增字段允许） */

/** 模块红外码 blob：完整字节串，含 2 字节大端总长与 FF FF FF FF 结尾 */
export type IrBlob = number[];

/** µs 精度脉宽时间线：从 mark(发射) 开始，mark/space 交替 */
export interface PulseTrain {
  /** 载波 Hz，未知填 38000 */
  carrierHz: number;
  /** mark/space 交替的时长数组（µs），首元素为 mark */
  pulses: number[];
}

/** 协议识别结果 */
export interface DecodedFrame {
  protocol: string;          // 'NEC' | 'RC5' | 'SONY' | ...
  protocolVariant?: string;  // 'SIRC-20' | 'RC6A' | ...
  address?: number;
  command?: number;
  extra?: Record<string, number | string | boolean>;
  /** 0-1 置信度（抗干扰多数表决/容差拟合度） */
  confidence: number;
  /** 原始脉宽（µs） */
  raw: number[];
  carrierHz: number;
}

/** 硬件能力（启动检测填充） */
export interface HwCaps {
  port: string;
  baud: number;
  tx: boolean;
  rx: boolean;
  carrierHz: number;
  slots: number;
  emitters: number;
}

export interface PortInfo {
  portName: string;
  friendlyName: string;
}

/** 预设（用户保存的常用码） */
export interface Preset {
  id: string;
  name: string;
  category: string;      // 空调/电视/...
  group: string;         // 分组
  protocol?: string;
  blob?: IrBlob;         // 模块 blob（可发射）
  train?: PulseTrain;    // 或 µs 时间线
  source: 'learned' | 'library' | 'custom' | 'ai';
  createdAt: number;
  useCount: number;
}

/** 码库条目 */
export interface CodeEntry {
  id: string;
  brand: string;
  brandAliases?: string[];
  deviceType: string;    // tv/ac/stb/dvd/projector/amp/fan/light/air/...
  deviceTypeName: string;
  key: string;           // power / vol_up / temp_26 ...
  keyName: string;
  protocol: string;
  address?: number;
  command?: number;
  carrierHz: number;
  /** 直接可用的 µs 时间线（生成好的） */
  pulses: number[];
  source: 'offline' | 'online';
}

/** 格式互转中枢表示 */
export interface CanonicalSignal {
  carrierHz: number;
  pulses: number[];      // µs，mark 起交替
}

export type ConvertFormat =
  | 'auto' | 'pronto' | 'lirc' | 'broadlink_hex' | 'broadlink_b64'
  | 'raw' | 'json' | 'xml' | 'module';

/** 模块 blob 时间单位（µs），待真机校准 */
export const MODULE_TICK_US = 100;

/** 语音指令解析结果 */
export interface VoiceCommand {
  deviceType?: string;
  brand?: string;
  action: string;
  value?: number | string;
  raw: string;
  followUps?: VoiceCommand[];
}

export interface AiToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
