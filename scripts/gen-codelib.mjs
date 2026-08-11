#!/usr/bin/env node
/**
 * 离线码库生成脚本
 * 用法: node scripts/gen-codelib.mjs
 * 输出: src/assets/codes/codes.json
 *
 * 用内嵌的简版协议时序编码器（NEC/NECext/SIRC/RC5/Samsung/Panasonic-Kaseikyo/
 * Sharp/JVC/Gree/Midea）为 66+ 品牌 × 11 类设备合成真实协议参数的 µs 脉宽码。
 * 知名品牌使用公开可查的 address / command（Samsung 0x0707、LG 0x20DF、
 * Sony SIRC、Panasonic 0x4004、Philips RC5、Gree/Midea 自有帧结构），
 * 其余品牌使用结构合法、参数确定性的合成码（仅供开发/联调，真机以学习码为准）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../src/assets/codes/codes.json');
const CARRIER = 38000;
const VERSION = '1.0.0';

/* ---------------- 协议编码器（µs 脉宽，mark 起交替） ---------------- */

/** 通用：字节数组 LSB-first 转成脉宽（不含 leader/footer） */
function bitsToPulses(bytes, mark, zeroSpace, oneSpace) {
  const out = [];
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      out.push(mark, (byte >> i) & 1 ? oneSpace : zeroSpace);
    }
  }
  return out;
}

/** NEC / NECext：address 为 16bit（经典 NEC 由调用方传 addr | ~addr<<8） */
function encodeNEC(address16, command) {
  const bytes = [address16 & 0xff, (address16 >> 8) & 0xff, command & 0xff, ~command & 0xff];
  return [9000, 4500, ...bitsToPulses(bytes, 560, 560, 1690), 560];
}

/** Samsung：leader 4500/4500，8bit 地址重复两遍，再发 cmd 与 ~cmd（32bit） */
function encodeSamsung(address16, command) {
  const a = address16 & 0xff; // 0x0707 这类写法两字节相同
  const bytes = [a, a, command & 0xff, ~command & 0xff];
  return [4500, 4500, ...bitsToPulses(bytes, 560, 560, 1690), 560];
}

/** Sony SIRC 12/15/20 bit */
function encodeSIRC(command, address, bits = 12, ext = 0) {
  let value, total;
  if (bits === 20) { value = (command & 0x7f) | ((address & 0x1f) << 7) | ((ext & 0xff) << 12); total = 20; }
  else if (bits === 15) { value = (command & 0x7f) | ((address & 0xff) << 7); total = 15; }
  else { value = (command & 0x7f) | ((address & 0x1f) << 7); total = 12; }
  const out = [2400, 600];
  for (let i = 0; i < total; i++) out.push((value >> i) & 1 ? 1200 : 600, 600);
  return out;
}

/** RC5：曼彻斯特双相，14bit（1,1,toggle,addr5,cmd6） */
function encodeRC5(address, command, toggle = 0) {
  const bits = [1, 1, toggle & 1];
  for (let i = 4; i >= 0; i--) bits.push((address >> i) & 1);
  for (let i = 5; i >= 0; i--) bits.push((command >> i) & 1);
  // 半比特 889µs；逻辑 1 = 前半 mark 后半 space，逻辑 0 相反
  const halves = [];
  for (const b of bits) halves.push(b ? 1 : 0, b ? 0 : 1);
  const out = [];
  for (const level of halves) {
    const isMark = out.length % 2 === 0;
    if ((level === 1) === isMark) {
      out.push(889);
    } else {
      out[out.length - 1] += 889; // 与上一段同电平，合并
    }
  }
  if (out.length % 2 === 0) out.push(889); // 保证偶数段（mark 起 space 止）
  return out;
}

/** Panasonic Kaseikyo 48bit（6 字节）：厂商码 0x2002 + 16bit 地址 + 8bit 命令 + xor 校验 */
function encodeKaseikyo(address16, command) {
  const b2 = address16 & 0xff, b3 = (address16 >> 8) & 0xff;
  const b4 = command & 0xff;
  const bytes = [0x02, 0x20, b2, b3, b4, b2 ^ b3 ^ b4];
  return [3500, 1750, ...bitsToPulses(bytes, 432, 432, 1296), 432];
}

/** Sharp 简版：5bit addr + 8bit cmd + ext + check，LSB-first */
function encodeSharp(address, command) {
  const out = [];
  const pushBit = (b) => out.push(320, b ? 1680 : 680);
  for (let i = 0; i < 5; i++) pushBit((address >> i) & 1);
  for (let i = 0; i < 8; i++) pushBit((command >> i) & 1);
  pushBit(0); pushBit(0);
  out.push(320);
  return out;
}

/** JVC：8bit addr + 8bit cmd，无反码 */
function encodeJVC(address, command) {
  return [8400, 4200, ...bitsToPulses([address & 0xff, command & 0xff], 525, 525, 1575), 525];
}

/** Gree 64bit：header 9000/4500，620/540/1620，第 32 位后插 620+19980 连接符。
 *  低 4 字节为 AC 状态（模式/温度/风速/扫风/睡眠/定时），byte4 放键码（合成约定），byte7 低 4 位校验 */
function encodeGree({ mode = 1, temp = 25, fan = 0, swing = 0, power = 1, sleep = 0, timer = 0 }, cmdCode = 0) {
  const b0 = (mode & 7) | ((power & 1) << 3) | ((fan & 3) << 4);
  const b1 = ((Math.max(16, Math.min(30, temp)) - 16) & 0xf) | ((swing & 1) << 4);
  const b2 = 0, b3 = ((sleep & 1) | ((timer & 1) << 1));
  const b4 = cmdCode & 0xff, b5 = 0, b6 = 0;
  let sum = 0;
  for (const b of [b0, b1, b2, b3, b4, b5, b6]) sum += (b & 0xf) + (b >> 4);
  const b7 = (sum + 0x0a) & 0xf;
  const bytes = [b0, b1, b2, b3, b4, b5, b6, b7];
  const out = [9000, 4500];
  for (let bit = 0; bit < 64; bit++) {
    if (bit === 32) out.push(620, 19980);
    out.push(620, (bytes[bit >> 3] >> (bit & 7)) & 1 ? 1620 : 540);
  }
  out.push(620);
  return out;
}

/** Midea 48bit：header 4480/4480，A,~A,C,~C,B,~B（LSB first）。
 *  A=0xB2 固定，C=键码（合成约定），B=AC 状态（模式/风速/扫风/睡眠/电源） */
function encodeMidea({ mode = 2, fan = 0, swing = 0, power = 1, sleep = 0 }, cmdCode = 0) {
  const a = 0xb2;
  const c = cmdCode & 0xff;
  const b = (mode & 7) | ((fan & 3) << 3) | ((swing & 1) << 5) | ((sleep & 1) << 6) | ((power & 1) << 7);
  const bytes = [a, a ^ 0xff, c, c ^ 0xff, b, b ^ 0xff];
  return [4480, 4480, ...bitsToPulses(bytes, 560, 560, 1690), 560];
}

/* ---------------- 品类与按键定义 ---------------- */

const DEVICE_TYPE_NAMES = {
  tv: '电视', ac: '空调', stb: '机顶盒', box: '盒子', dvd: 'DVD', projector: '投影仪',
  amp: '功放', fan: '风扇', light: '灯', air: '净化器', speaker: '音响',
};

const KEYSETS = {
  tv: [
    ['power', '电源'], ['mute', '静音'], ['vol_up', '音量+'], ['vol_down', '音量-'],
    ['ch_up', '频道+'], ['ch_down', '频道-'], ['menu', '菜单'], ['ok', '确认'],
    ['up', '上'], ['down', '下'], ['left', '左'], ['right', '右'],
    ['back', '返回'], ['home', '主页'], ['input', '信号源'],
    ...Array.from({ length: 10 }, (_, i) => [`num_${i}`, `数字${i}`]),
  ],
  ac: [
    ['power', '电源'], ['temp_up', '温度+'], ['temp_down', '温度-'], ['temp_26', '26度'],
    ['mode_cool', '制冷'], ['mode_heat', '制热'], ['mode_auto', '自动模式'],
    ['mode_dry', '除湿'], ['mode_fan', '送风'], ['fan_speed', '风速'],
    ['swing', '扫风'], ['sleep', '睡眠'], ['timer', '定时'],
  ],
  stb: [
    ['power', '电源'], ['ch_up', '频道+'], ['ch_down', '频道-'], ['vol_up', '音量+'],
    ['vol_down', '音量-'], ['mute', '静音'], ['ok', '确认'], ['up', '上'], ['down', '下'],
    ['left', '左'], ['right', '右'], ['menu', '菜单'], ['back', '返回'], ['home', '主页'],
    ...Array.from({ length: 10 }, (_, i) => [`num_${i}`, `数字${i}`]),
  ],
  box: [
    ['power', '电源'], ['ch_up', '频道+'], ['ch_down', '频道-'], ['vol_up', '音量+'],
    ['vol_down', '音量-'], ['mute', '静音'], ['ok', '确认'], ['up', '上'], ['down', '下'],
    ['left', '左'], ['right', '右'], ['menu', '菜单'], ['back', '返回'], ['home', '主页'],
    ...Array.from({ length: 10 }, (_, i) => [`num_${i}`, `数字${i}`]),
  ],
  dvd: [
    ['power', '电源'], ['eject', '出仓'], ['play', '播放'], ['pause', '暂停'], ['stop', '停止'],
    ['prev', '上一曲'], ['next', '下一曲'], ['ff', '快进'], ['rew', '快退'],
    ['menu', '菜单'], ['ok', '确认'], ['up', '上'], ['down', '下'], ['left', '左'], ['right', '右'],
    ...Array.from({ length: 10 }, (_, i) => [`num_${i}`, `数字${i}`]),
  ],
  projector: [
    ['power', '电源'], ['input', '信号源'], ['menu', '菜单'], ['ok', '确认'],
    ['up', '上'], ['down', '下'], ['left', '左'], ['right', '右'],
    ['vol_up', '音量+'], ['vol_down', '音量-'], ['mute', '静音'],
  ],
  amp: [
    ['power', '电源'], ['vol_up', '音量+'], ['vol_down', '音量-'], ['mute', '静音'],
    ['input_dvd', 'DVD输入'], ['input_cd', 'CD输入'], ['input_aux', 'AUX输入'], ['mode', '音效模式'],
  ],
  fan: [['power', '电源'], ['fan_speed', '风速'], ['swing', '摇头'], ['timer', '定时'], ['mode', '风类']],
  light: [
    ['power', '电源'], ['bright_up', '亮度+'], ['bright_down', '亮度-'],
    ['mode', '模式'], ['warm', '暖光'], ['cool', '冷光'],
  ],
  air: [
    ['power', '电源'], ['fan_speed', '风速'], ['mode', '模式'],
    ['swing', '摆风'], ['timer', '定时'], ['sleep', '睡眠'],
  ],
  speaker: [
    ['power', '电源'], ['vol_up', '音量+'], ['vol_down', '音量-'], ['mute', '静音'],
    ['play', '播放/暂停'], ['prev', '上一曲'], ['next', '下一曲'], ['input', '输入切换'],
  ],
};

/* ---------------- 命令码表 ---------------- */

/** NEC 系通用命令表（合成，结构合法） */
const NEC_GENERIC = {
  power: 0x02, mute: 0x0f, vol_up: 0x07, vol_down: 0x0b, ch_up: 0x12, ch_down: 0x10,
  menu: 0x1a, ok: 0x0d, up: 0x60, down: 0x61, left: 0x62, right: 0x63, back: 0x1c,
  home: 0x1f, input: 0x01, eject: 0x16, play: 0x17, pause: 0x18, stop: 0x19,
  prev: 0x1b, next: 0x1d, ff: 0x1e, rew: 0x20, temp_up: 0x0a, temp_down: 0x0e,
  temp_26: 0x21, mode_cool: 0x22, mode_heat: 0x23, mode_auto: 0x24, mode_dry: 0x25,
  mode_fan: 0x26, fan_speed: 0x27, swing: 0x28, sleep: 0x29, timer: 0x2a,
  bright_up: 0x2b, bright_down: 0x2c, warm: 0x2d, cool: 0x2e, mode: 0x2f,
  input_dvd: 0x31, input_cd: 0x32, input_aux: 0x33,
  num_0: 0x40, num_1: 0x41, num_2: 0x42, num_3: 0x43, num_4: 0x44,
  num_5: 0x45, num_6: 0x46, num_7: 0x47, num_8: 0x48, num_9: 0x49,
};

/** Samsung TV 真实常用码（address 0x0707） */
const SAMSUNG_TV = {
  power: 0x02, vol_up: 0x07, vol_down: 0x0b, ch_up: 0x12, ch_down: 0x10, mute: 0x0f,
  input: 0x01, menu: 0x1a, ok: 0x68, up: 0x60, down: 0x61, left: 0x65, right: 0x62,
  back: 0x58, home: 0x79,
  num_1: 0x04, num_2: 0x05, num_3: 0x06, num_4: 0x08, num_5: 0x09,
  num_6: 0x0a, num_7: 0x0c, num_8: 0x0d, num_9: 0x0e, num_0: 0x11,
};

/** LG TV 真实常用码（NECext address 0x20DF） */
const LG_TV = {
  power: 0x08, vol_up: 0x02, vol_down: 0x03, ch_up: 0x00, ch_down: 0x01, mute: 0x09,
  menu: 0x43, ok: 0x44, up: 0x40, down: 0x41, left: 0x07, right: 0x06, back: 0x28,
  home: 0x3e, input: 0x0b,
  num_0: 0x10, num_1: 0x11, num_2: 0x12, num_3: 0x13, num_4: 0x14,
  num_5: 0x15, num_6: 0x16, num_7: 0x17, num_8: 0x18, num_9: 0x19,
};

/** Sony TV SIRC-12（address 1）真实常用码 */
const SONY_TV = {
  power: 0x15, vol_up: 0x12, vol_down: 0x13, ch_up: 0x10, ch_down: 0x11, mute: 0x14,
  input: 0x25, menu: 0x60, ok: 0x65, home: 0x60,
  num_1: 0x00, num_2: 0x01, num_3: 0x02, num_4: 0x03, num_5: 0x04,
  num_6: 0x05, num_7: 0x06, num_8: 0x07, num_9: 0x08, num_0: 0x09,
};

/** Sony DVD / AMP SIRC 通用（合成） */
const SONY_GENERIC = {
  ...SONY_TV, play: 0x32, pause: 0x39, stop: 0x38, prev: 0x30, next: 0x31,
  eject: 0x16, ff: 0x33, rew: 0x34, input_dvd: 0x36, input_cd: 0x37, input_aux: 0x38,
  mode: 0x3a, back: 0x3b, up: 0x3c, down: 0x3d, left: 0x3e, right: 0x3f,
};

/** Panasonic TV Kaseikyo（vendor 0x4004）常用码 */
const PANASONIC_TV = {
  power: 0x3d, vol_up: 0x20, vol_down: 0x21, ch_up: 0x34, ch_down: 0x35, mute: 0x18,
  input: 0x25, menu: 0x32, ok: 0x3b, up: 0x53, down: 0x54, left: 0x55, right: 0x56,
  back: 0x36, home: 0x37, play: 0x48, pause: 0x49, stop: 0x4a, prev: 0x4b, next: 0x4c,
  num_0: 0x00, num_1: 0x01, num_2: 0x02, num_3: 0x03, num_4: 0x04,
  num_5: 0x05, num_6: 0x06, num_7: 0x07, num_8: 0x08, num_9: 0x09,
};

/** Philips RC5（address 0）标准命令 */
const PHILIPS_RC5 = {
  power: 0x0c, mute: 0x0d, vol_up: 0x10, vol_down: 0x11, ch_up: 0x20, ch_down: 0x21,
  menu: 0x3b, ok: 0x2e, input: 0x38, play: 0x35, pause: 0x30, stop: 0x36,
  prev: 0x32, next: 0x33, bright_up: 0x28, bright_down: 0x29, warm: 0x2a, cool: 0x2b,
  mode: 0x2c, up: 0x58, down: 0x59, left: 0x5a, right: 0x5b, back: 0x22, home: 0x3c,
  num_0: 0x00, num_1: 0x01, num_2: 0x02, num_3: 0x03, num_4: 0x04,
  num_5: 0x05, num_6: 0x06, num_7: 0x07, num_8: 0x08, num_9: 0x09,
};

/** 空调键 → 参数（Gree/Midea 帧用） */
function acParams(key) {
  switch (key) {
    case 'power': return { power: 1 };
    case 'temp_up': return { temp: 27 };
    case 'temp_down': return { temp: 20 };
    case 'temp_26': return { temp: 26 };
    case 'mode_cool': return { mode: 1 };
    case 'mode_heat': return { mode: 4 };
    case 'mode_auto': return { mode: 0 };
    case 'mode_dry': return { mode: 2 };
    case 'mode_fan': return { mode: 3 };
    case 'fan_speed': return { fan: 2 };
    case 'swing': return { swing: 1 };
    case 'sleep': return { sleep: 1 };
    case 'timer': return { timer: 1 };
    default: return {};
  }
}

const AC_CMD_CODE = {
  power: 0x01, temp_up: 0x02, temp_down: 0x03, temp_26: 0x1a, mode_cool: 0x10,
  mode_heat: 0x11, mode_auto: 0x12, mode_dry: 0x13, mode_fan: 0x14,
  fan_speed: 0x20, swing: 0x21, sleep: 0x22, timer: 0x23,
};

/* ---------------- 品牌表（67 品牌） ----------------
 * devices: { <deviceType>: { proto, variant?, address, cmds? } }
 * proto: nec | necext | samsung | sirc | rc5 | kaseikyo | sharp | jvc | gree | midea
 */
const nec = (address, cmds) => ({ proto: 'necext', address, cmds });
const B = (name, aliases, devices) => ({ name, aliases, devices });

const BRANDS = [
  B('索尼', ['sony', 'Sony', 'SONY'], {
    tv: { proto: 'sirc', variant: 'SIRC-12', address: 0x01, cmds: SONY_TV },
    dvd: { proto: 'sirc', variant: 'SIRC-15', address: 26, cmds: SONY_GENERIC },
    amp: { proto: 'sirc', variant: 'SIRC-15', address: 16, cmds: SONY_GENERIC },
    speaker: { proto: 'sirc', variant: 'SIRC-15', address: 17, cmds: SONY_GENERIC },
  }),
  B('三星', ['samsung', 'Samsung', 'SAMSUNG'], {
    tv: { proto: 'samsung', address: 0x0707, cmds: SAMSUNG_TV },
    dvd: nec(0x20e0),
  }),
  B('LG', ['lg', 'LG', '乐金'], {
    tv: nec(0x20df, LG_TV),
    dvd: nec(0xc1a0),
  }),
  B('松下', ['panasonic', 'Panasonic', '松下电器'], {
    tv: { proto: 'kaseikyo', address: 0x4004, cmds: PANASONIC_TV },
    dvd: { proto: 'kaseikyo', address: 0x4004, cmds: PANASONIC_TV },
    ac: nec(0x0660),
  }),
  B('夏普', ['sharp', 'Sharp', 'SHARP'], {
    tv: { proto: 'sharp', address: 0x01, cmds: { ...NEC_GENERIC, power: 0x02, input: 0x03 } },
  }),
  B('东芝', ['toshiba', 'Toshiba', 'TOSHIBA'], { tv: nec(0x4040) }),
  B('飞利浦', ['philips', 'Philips', 'PHILIPS'], {
    tv: { proto: 'rc5', address: 0, cmds: PHILIPS_RC5 },
    dvd: { proto: 'rc5', address: 4, cmds: PHILIPS_RC5 },
    light: { proto: 'rc5', address: 1, cmds: PHILIPS_RC5 },
  }),
  B('TCL', ['tcl', 'TCL', '王牌'], { tv: nec(0x807f) }),
  B('海信', ['hisense', 'Hisense'], { tv: nec(0x40bf), ac: nec(0x08f7) }),
  B('创维', ['skyworth', 'Skyworth', '创维电视'], { tv: nec(0x0df2) }),
  B('长虹', ['changhong', 'Changhong'], { tv: nec(0x10ef), ac: nec(0x18e7) }),
  B('康佳', ['konka', 'Konka', 'KONKA'], { tv: nec(0x28d7) }),
  B('小米', ['xiaomi', 'Xiaomi', 'MI', 'mi'], {
    tv: nec(0xee11), box: nec(0xee12), speaker: nec(0xee13), air: nec(0xee14), light: nec(0xee15),
  }),
  B('华为', ['huawei', 'Huawei', 'HUAWEI', '华为智慧屏'], { tv: nec(0xd22d) }),
  B('格力', ['gree', 'Gree', 'GREE'], {
    ac: { proto: 'gree', address: 0x00, cmds: AC_CMD_CODE },
    fan: nec(0x6e91),
  }),
  B('美的', ['midea', 'Midea'], {
    ac: { proto: 'midea', address: 0x00, cmds: AC_CMD_CODE },
    fan: nec(0x4db2), air: nec(0x4db3),
  }),
  B('海尔', ['haier', 'Haier'], { ac: nec(0x35ca), tv: nec(0x35cb) }),
  B('奥克斯', ['aux', 'AUX', '奥克斯空调'], { ac: nec(0x55aa) }),
  B('志高', ['chigo', 'Chigo', 'CHIGO'], { ac: nec(0x6699) }),
  B('大金', ['daikin', 'Daikin', 'DAIKIN'], { ac: nec(0x11da) }),
  B('三菱电机', ['mitsubishi', 'Mitsubishi Electric', '三菱'], { ac: nec(0x23cb) }),
  B('三菱重工', ['mitsubishi heavy', 'Mitsubishi Heavy'], { ac: nec(0x27d8) }),
  B('日立', ['hitachi', 'Hitachi', 'HITACHI'], { ac: nec(0x31ce), projector: nec(0x31cf) }),
  B('约克', ['york', 'York', 'YORK'], { ac: nec(0x39c6) }),
  B('开利', ['carrier', 'Carrier'], { ac: nec(0x41be) }),
  B('科龙', ['kelon', 'Kelon'], { ac: nec(0x49b6) }),
  B('华凌', ['hualin', 'Hualin', '华凌空调'], { ac: { proto: 'midea', address: 0x01, cmds: AC_CMD_CODE } }),
  B('统帅', ['leader', 'Leader', '统帅电器'], { ac: nec(0x51ae) }),
  B('扬子', ['yangzi', 'Yangzi', '扬子空调'], { ac: nec(0x59a6) }),
  B('新科', ['shinco', 'Shinco'], { ac: nec(0x619e), dvd: nec(0x619f) }),
  B('格兰仕', ['galanz', 'Galanz'], { ac: nec(0x6996) }),
  B('艾美特', ['airmate', 'Airmate', '艾美特风扇'], { fan: nec(0x719e) }),
  B('先锋', ['singfun', 'Singfun', '先锋电器'], { fan: nec(0x7986) }),
  B('戴森', ['dyson', 'Dyson', 'DYSON'], { fan: nec(0x817e), air: nec(0x817f) }),
  B('莱克', ['lexy', 'Lexy', 'LEXY'], { fan: nec(0x8976), air: nec(0x8977) }),
  B('爱普生', ['epson', 'Epson', 'EPSON'], { projector: { proto: 'nec', address: 0x83c1, cmds: NEC_GENERIC } }),
  B('明基', ['benq', 'BenQ'], { projector: nec(0x8b74) }),
  B('索尼投影', ['sony projector', '索尼投影仪'], { projector: { proto: 'sirc', variant: 'SIRC-15', address: 0x0e, cmds: SONY_GENERIC } }),
  B('极米', ['xgimi', 'XGIMI', '极米投影'], { projector: nec(0x936c) }),
  B('坚果', ['jmgo', 'JMGO', '坚果投影'], { projector: nec(0x9b64) }),
  B('当贝', ['dangbei', 'Dangbei', '当贝投影'], { projector: nec(0xa35c), box: nec(0xa35d) }),
  B('天龙', ['denon', 'Denon', 'DENON'], { amp: { proto: 'sharp', address: 0x02, cmds: NEC_GENERIC } }),
  B('马兰士', ['marantz', 'Marantz'], { amp: { proto: 'rc5', address: 16, cmds: PHILIPS_RC5 } }),
  B('雅马哈', ['yamaha', 'Yamaha', 'YAMAHA'], { amp: nec(0x7a85) }),
  B('安桥', ['onkyo', 'Onkyo', 'ONKYO'], { amp: nec(0x2ad5) }),
  B('哈曼卡顿', ['harman kardon', 'HarmanKardon', 'harman'], { amp: nec(0xc43b) }),
  B('JBL', ['jbl'], { speaker: nec(0xcc33) }),
  B('BOSE', ['bose', 'Bose', '博士音响'], { speaker: nec(0xd42b) }),
  B('漫步者', ['edifier', 'Edifier', 'EDIFIER'], { speaker: nec(0xdc23) }),
  B('惠威', ['hivi', 'HiVi', '惠威音响'], { speaker: nec(0xe41b) }),
  B('小米盒子', ['mi box', 'MiBox', '小米电视盒子'], { box: nec(0xee16) }),
  B('天猫魔盒', ['tmall box', 'TmallBox', '天猫'], { box: nec(0xec13) }),
  B('乐视', ['letv', 'Letv', 'LeTV', '乐视电视'], { tv: nec(0xf40b), box: nec(0xf40c) }),
  B('微鲸', ['whaley', 'Whaley', '微鲸电视'], { tv: nec(0xfc03) }),
  B('暴风', ['baofeng', 'BFTV', '暴风电视'], { tv: nec(0x04fb) }),
  B('PPTV', ['pptv', 'PPTV聚力'], { tv: nec(0x0cf3) }),
  B('中兴', ['zte', 'ZTE', '中兴机顶盒'], { stb: nec(0x14eb) }),
  B('华为盒子', ['huawei box', '华为悦盒'], { box: nec(0xd32c) }),
  B('移动魔百和', ['mobahe', 'CMCC', '魔百和', '中国移动'], { stb: nec(0x1ce3) }),
  B('电信IPTV', ['telecom iptv', '中国电信', '天翼高清'], { stb: nec(0x24db) }),
  B('联通', ['unicom', '中国联通', '联通IPTV'], { stb: nec(0x2cd3) }),
  B('歌华有线', ['gehua', '北京歌华', '歌华'], { stb: nec(0x34cb) }),
  B('东方有线', ['ocn', '上海东方有线'], { stb: nec(0x3cc3) }),
  B('华数', ['wasu', '华数传媒', '华数TV'], { stb: nec(0x44bb) }),
  B('珠江数码', ['zhujiang', '广州珠江数码'], { stb: nec(0x4cb3) }),
  B('富士通', ['fujitsu', 'Fujitsu', '富士通将军'], { ac: nec(0x54ab) }),
  B('春兰', ['chunlan', 'Chunlan', '春兰空调'], { ac: nec(0x5ca3) }),
];

/* ---------------- 合成 ---------------- */

function defaultCmds(proto) {
  if (proto === 'sirc') return SONY_GENERIC;
  if (proto === 'rc5') return PHILIPS_RC5;
  if (proto === 'kaseikyo') return PANASONIC_TV;
  if (proto === 'gree' || proto === 'midea') return AC_CMD_CODE;
  return NEC_GENERIC;
}

const PROTO_CARRIER = {
  nec: 38000, necext: 38000, samsung: 38000, sirc: 40000, rc5: 36000,
  kaseikyo: 36700, sharp: 38000, jvc: 38000, gree: 38000, midea: 38000,
};

function encodeEntry(dt, key, spec, keyIndex) {
  const cmds = spec.cmds ?? defaultCmds(spec.proto);
  let command = cmds[key];
  if (command === undefined) command = (0x10 + keyIndex * 7) & 0xff; // 兜底，确定性
  const carrierHz = PROTO_CARRIER[spec.proto] ?? 38000;
  switch (spec.proto) {
    case 'nec': { // 经典 NEC：8bit 地址 + 反码
      const a = spec.address & 0xff;
      return { protocol: 'NEC', address: spec.address, command, carrierHz, pulses: encodeNEC(a | ((~a & 0xff) << 8), command) };
    }
    case 'necext':
      return { protocol: 'NECext', address: spec.address, command, carrierHz, pulses: encodeNEC(spec.address & 0xffff, command) };
    case 'samsung':
      return { protocol: 'Samsung', address: spec.address, command, carrierHz, pulses: encodeSamsung(spec.address & 0xffff, command) };
    case 'sirc': {
      const bits = spec.variant === 'SIRC-20' ? 20 : spec.variant === 'SIRC-15' ? 15 : 12;
      return { protocol: 'SONY', protocolVariant: spec.variant ?? 'SIRC-12', address: spec.address, command, carrierHz, pulses: encodeSIRC(command, spec.address, bits) };
    }
    case 'rc5': {
      const c = command & 0x3f; // RC5 命令仅 6bit
      return { protocol: 'RC5', address: spec.address, command: c, carrierHz, pulses: encodeRC5(spec.address, c) };
    }
    case 'kaseikyo':
      return { protocol: 'Kaseikyo', protocolVariant: 'Panasonic', address: spec.address, command, carrierHz, pulses: encodeKaseikyo(spec.address & 0xffff, command) };
    case 'sharp':
      return { protocol: 'Sharp', address: spec.address, command, carrierHz, pulses: encodeSharp(spec.address, command) };
    case 'jvc':
      return { protocol: 'JVC', address: spec.address, command, carrierHz, pulses: encodeJVC(spec.address, command) };
    case 'gree':
      return { protocol: 'Gree', address: spec.address, command, carrierHz, pulses: encodeGree(acParams(key), command) };
    case 'midea':
      return { protocol: 'Midea', address: spec.address, command, carrierHz, pulses: encodeMidea(acParams(key), command) };
    default:
      throw new Error(`未知协议: ${spec.proto}`);
  }
}

function build() {
  const entries = [];
  let idSeq = 0;
  for (const brand of BRANDS) {
    for (const [dt, spec] of Object.entries(brand.devices)) {
      const keys = KEYSETS[dt];
      if (!keys) throw new Error(`品牌 ${brand.name} 未知品类 ${dt}`);
      keys.forEach(([key, keyName], keyIndex) => {
        const enc = encodeEntry(dt, key, spec, keyIndex);
        entries.push({
          id: `lib${String(++idSeq).padStart(5, '0')}`,
          brand: brand.name,
          brandAliases: brand.aliases,
          deviceType: dt,
          deviceTypeName: DEVICE_TYPE_NAMES[dt],
          key,
          keyName,
          protocol: enc.protocol,
          address: enc.address,
          command: enc.command,
          carrierHz: enc.carrierHz,
          pulses: enc.pulses,
          source: 'offline',
        });
      });
    }
  }
  return entries;
}

const entries = build();

// 统计
const protoDist = {};
const dtSet = new Set();
for (const e of entries) {
  protoDist[e.protocol] = (protoDist[e.protocol] ?? 0) + 1;
  dtSet.add(e.deviceType);
}

const payload = {
  version: VERSION,
  generatedAt: new Date().toISOString(),
  count: entries.length,
  entries,
};

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(payload);
writeFileSync(OUT, json);

const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(2);
console.log(`✔ 码库已生成: ${OUT}`);
console.log(`  条目数:   ${entries.length}`);
console.log(`  品牌数:   ${BRANDS.length}`);
console.log(`  品类数:   ${dtSet.size} (${[...dtSet].join(', ')})`);
console.log(`  协议分布: ${Object.entries(protoDist).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log(`  文件大小: ${sizeMB} MB`);
console.log(`  版本:     ${VERSION}`);
