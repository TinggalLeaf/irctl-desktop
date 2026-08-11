/**
 * 中文语音指令解析引擎（纯规则+模板，无外部依赖）
 *
 * - 唤醒词「小控」剥离
 * - 品类别名表 / 动作表 / 中文数字与阿拉伯数字提取
 * - 组合指令按「然后/再/接着/并且/，」等切分
 * - 上下文继承：缺品类/品牌时沿用 ctx.lastDeviceType / ctx.lastBrand
 *
 * 自测：node src/lib/voice/selftest.ts
 */
import type { VoiceCommand } from '../../types/ir';

/** 语音上下文（上次指令的品类/品牌，用于省略主语时的继承） */
export interface VoiceContext {
  lastDeviceType?: string;
  lastBrand?: string;
}

/** 品类别名表（长别名在前，优先匹配） */
const DEVICE_ALIASES: Array<[string, string[]]> = [
  ['projector', ['投影仪', '投影机', '投影']],
  ['air', ['空气净化器', '净化器']],
  ['stb', ['机顶盒']],
  ['box', ['电视盒子', '网络盒子', '盒子']],
  ['speaker', ['智能音箱', '音响', '音箱']],
  ['amp', ['功放']],
  ['ac', ['空调']],
  ['tv', ['电视机', '电视', '彩电']],
  ['fan', ['电风扇', '电扇', '风扇']],
  ['dvd', ['影碟机', 'DVD', 'dvd']],
  ['light', ['灯泡', '灯光', '台灯', '灯']],
];

/** 常见品牌词（用于从指令中提取品牌） */
const BRAND_WORDS = [
  '哈曼卡顿', '三菱电机', '三菱重工', '马兰士', '爱普生', '奥克斯', '飞利浦', '格兰仕',
  '艾美特', '漫步者', '雅马哈', '惠威', '索尼', '三星', '松下', '夏普', '东芝', '飞利浦',
  '海信', '创维', '长虹', '康佳', '小米', '华为', '格力', '美的', '海尔', '志高', '大金',
  '日立', '约克', '开利', '科龙', '华凌', '统帅', '扬子', '新科', '先锋', '戴森', '莱克',
  '明基', '极米', '坚果', '当贝', '天龙', '安桥', '乐视', '微鲸', '暴风', '中兴', 'LG',
  'TCL', 'JBL', 'BOSE', 'PPTV', '富士通', '春兰',
];

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const NUM_TOKEN = '[0-9]+|[零一二两三四五六七八九十]{1,4}';

/** 中文/阿拉伯数字 → number，无法解析返回 undefined */
export function parseVoiceNumber(token: string | undefined): number | undefined {
  if (!token) return undefined;
  if (/^[0-9]+$/.test(token)) return parseInt(token, 10);
  if (token.includes('十')) {
    const [a, b] = token.split('十');
    const tens = a ? CN_DIGITS[a] : 1;
    const ones = b ? CN_DIGITS[b] : 0;
    if (tens === undefined || ones === undefined) return undefined;
    return tens * 10 + ones;
  }
  if (token.length === 1) return CN_DIGITS[token];
  // 逐位读法，如 "二六" → 26
  if ([...token].every((c) => c in CN_DIGITS)) {
    return parseInt([...token].map((c) => CN_DIGITS[c]).join(''), 10);
  }
  return undefined;
}

interface ActionRule {
  action: string;
  pattern: RegExp;
  /** 从匹配里提取 value */
  value?: (m: RegExpMatchArray, seg: string) => number | string | undefined;
}

const numIn = (name: string) => new RegExp(`(?:${name})[^0-9零一二两三四五六七八九十]{0,4}(${NUM_TOKEN})`);

/** 动作规则表（同一片段可命中多条，按表序输出；数值规则优先于趋势规则） */
const ACTION_RULES: ActionRule[] = [
  // —— 数值设定 ——
  {
    action: 'temp_set',
    pattern: new RegExp(`(${NUM_TOKEN})\\s*度`),
    value: (m) => parseVoiceNumber(m[1]),
  },
  {
    action: 'vol_set',
    pattern: numIn('音量|声音'),
    value: (m) => parseVoiceNumber(m[1]),
  },
  {
    action: 'ch_set',
    pattern: new RegExp(`(?:(${NUM_TOKEN})\\s*(?:台|频道)|(?:频道|台)[^0-9零一二两三四五六七八九十]{0,4}(${NUM_TOKEN})|中央(${NUM_TOKEN}))`),
    value: (m) => parseVoiceNumber(m[1] ?? m[2] ?? m[3]),
  },
  // —— 电源 ——
  { action: 'power_on', pattern: /打开|开启|开机|开(?![冷热水风])/ },
  { action: 'power_off', pattern: /关闭|关掉|关上|关机|关(?![于注])/ },
  // —— 空调模式 ——
  { action: 'mode_cool', pattern: /制冷/ },
  { action: 'mode_heat', pattern: /制热|暖气/ },
  { action: 'mode_fan', pattern: /送风/ },
  { action: 'mode_dry', pattern: /除湿|抽湿/ },
  { action: 'mode_auto', pattern: /自动模式/ },
  { action: 'swing', pattern: /扫风|摆风|摇头/ },
  { action: 'sleep', pattern: /睡眠/ },
  { action: 'timer', pattern: /定时/ },
  {
    action: 'fan_speed',
    pattern: /风速|风力|风量/,
    value: (_m, seg) => (/大|高|强/.test(seg) ? 'up' : /小|低|弱/.test(seg) ? 'down' : undefined),
  },
  // —— 温度趋势 ——
  { action: 'temp_up', pattern: /温度.{0,3}(高|升)|调高.{0,2}温度|热一点|热点/ },
  { action: 'temp_down', pattern: /温度.{0,3}(低|降)|调低.{0,2}温度|冷一点|冷点|凉一点|凉快点/ },
  // —— 音量/静音 ——
  { action: 'mute', pattern: /静音/ },
  { action: 'vol_up', pattern: /音量.{0,3}(大|高|加|升)|声音.{0,3}(大|高)|(调|开|加|放)大.{0,2}(音量|声音)|大声/ },
  { action: 'vol_down', pattern: /音量.{0,3}(小|低|减|降)|声音.{0,3}(小|低)|(调|关)小.{0,2}(音量|声音)|小声/ },
  // —— 频道 ——
  { action: 'ch_up', pattern: /下一个频道|下个台|上一台|频道\+|换个台|换台/ },
  { action: 'ch_down', pattern: /上一个频道|上个台|下一台|频道-/ },
  // —— 导航 ——
  { action: 'menu', pattern: /菜单/ },
  { action: 'ok', pattern: /确定|确认/ },
  { action: 'back', pattern: /返回/ },
  { action: 'home', pattern: /主页|首页|回桌面/ },
  { action: 'up', pattern: /方向上|往上|按上/ },
  { action: 'down', pattern: /方向下|往下|按下(?![一])/ },
  { action: 'left', pattern: /方向左|往左|按左/ },
  { action: 'right', pattern: /方向右|往右|按右/ },
  // —— 播放控制 ——
  { action: 'play', pattern: /播放|继续/ },
  { action: 'pause', pattern: /暂停/ },
  { action: 'stop', pattern: /停止/ },
  { action: 'prev', pattern: /上一(曲|首|个)/ },
  { action: 'next', pattern: /下一(曲|首|个)/ },
  { action: 'eject', pattern: /出仓|弹仓/ },
  // —— 灯 ——
  { action: 'bright_up', pattern: /调亮|亮一点|亮点|亮度.{0,3}(大|高)/ },
  { action: 'bright_down', pattern: /调暗|暗一点|暗点|亮度.{0,3}(小|低)/ },
];

/** 剥离唤醒词「小控」（含重复/带语气词） */
export function stripWakeWord(text: string): string {
  return text.replace(/^\s*(?:小控[，,、。!！\s]*)+/, '');
}

/** 组合指令切分 */
function splitSegments(text: string): string[] {
  return text
    .split(/然后|接着|并且|而且|还有|再(?![见次遍])|顺便|[，,；;。！!]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectDeviceType(seg: string): string | undefined {
  for (const [dt, aliases] of DEVICE_ALIASES) {
    for (const a of aliases) {
      if (seg.includes(a)) return dt;
    }
  }
  return undefined;
}

function detectBrand(seg: string): string | undefined {
  for (const b of BRAND_WORDS) {
    if (seg.includes(b)) return b;
  }
  return undefined;
}

/**
 * 解析一条中文语音指令，返回 0..n 条 VoiceCommand。
 * 组合指令拆成多条（扁平数组，顺序即执行顺序）；
 * 片段缺品类/品牌时继承 ctx，同句内后面的片段继承前面的解析结果。
 */
export function parseVoice(text: string, ctx: VoiceContext = {}): VoiceCommand[] {
  const cleaned = stripWakeWord(text).trim();
  if (!cleaned) return [];

  const segments = splitSegments(cleaned);
  const commands: VoiceCommand[] = [];
  let lastDeviceType = ctx.lastDeviceType;
  let lastBrand = ctx.lastBrand;

  for (const seg of segments) {
    const dt = detectDeviceType(seg) ?? lastDeviceType;
    const brand = detectBrand(seg) ?? lastBrand;
    let matched = false;

    for (const rule of ACTION_RULES) {
      const m = seg.match(rule.pattern);
      if (!m) continue;
      matched = true;
      const cmd: VoiceCommand = { action: rule.action, raw: seg };
      if (dt) cmd.deviceType = dt;
      if (brand) cmd.brand = brand;
      const v = rule.value?.(m, seg);
      if (v !== undefined) cmd.value = v;
      commands.push(cmd);
    }

    if (!matched) {
      const cmd: VoiceCommand = { action: 'unknown', raw: seg };
      if (dt) cmd.deviceType = dt;
      if (brand) cmd.brand = brand;
      commands.push(cmd);
    }

    if (dt) lastDeviceType = dt;
    if (brand) lastBrand = brand;
  }

  return commands;
}
