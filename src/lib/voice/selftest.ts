/**
 * voice 解析器自测（Node ≥22.6 直接可跑）：
 *   node src/lib/voice/selftest.ts
 */
import { parseVoice, parseVoiceNumber, stripWakeWord } from './index.ts';
import type { VoiceCommand } from '../../types/ir';

// node 直接运行时需要 process（项目未装 @types/node，做最小声明）
declare const process: { exit(code: number): void };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name}`, detail ?? '');
  }
}

function summary(cmds: VoiceCommand[]): string {
  return JSON.stringify(cmds.map((c) => [c.deviceType, c.brand, c.action, c.value]));
}

console.log('— 唤醒词剥离 —');
check('小控前缀', stripWakeWord('小控，打开空调') === '打开空调');
check('小控重复', stripWakeWord('小控小控 打开电视') === '打开电视');
check('无唤醒词原样', stripWakeWord('打开空调') === '打开空调');

console.log('— 数字解析 —');
check('阿拉伯数字', parseVoiceNumber('26') === 26);
check('中文单位数', parseVoiceNumber('五') === 5);
check('中文十几', parseVoiceNumber('十六') === 16);
check('中文几十几', parseVoiceNumber('二十六') === 26);
check('中文整十', parseVoiceNumber('三十') === 30);
check('逐位读法', parseVoiceNumber('二六') === 26);

console.log('— 基础指令 —');
let cmds = parseVoice('小控，打开空调');
check('打开空调 → ac/power_on', cmds.length === 1 && cmds[0].deviceType === 'ac' && cmds[0].action === 'power_on', summary(cmds));

cmds = parseVoice('关闭电视');
check('关闭电视 → tv/power_off', cmds[0]?.deviceType === 'tv' && cmds[0]?.action === 'power_off', summary(cmds));

cmds = parseVoice('把空调温度调到26度');
check('26度 → temp_set 26', cmds[0]?.action === 'temp_set' && cmds[0]?.value === 26 && cmds[0]?.deviceType === 'ac', summary(cmds));

cmds = parseVoice('空调二十六度');
check('二十六度 → temp_set 26', cmds.some((c) => c.action === 'temp_set' && c.value === 26), summary(cmds));

cmds = parseVoice('电视音量调大一点');
check('音量调大 → vol_up', cmds.some((c) => c.action === 'vol_up' && c.deviceType === 'tv'), summary(cmds));

cmds = parseVoice('空调制冷然后扫风');
check('组合指令 2 条', cmds.length === 2 && cmds[0].action === 'mode_cool' && cmds[1].action === 'swing', summary(cmds));

cmds = parseVoice('打开投影仪，再静音');
check('组合+继承品类', cmds.length >= 2 && cmds[0].deviceType === 'projector' && cmds[1].action === 'mute' && cmds[1].deviceType === 'projector', summary(cmds));

console.log('— 上下文继承 —');
cmds = parseVoice('温度调低一点', { lastDeviceType: 'ac', lastBrand: '格力' });
check('缺品类沿用 ctx', cmds[0]?.deviceType === 'ac' && cmds[0]?.action === 'temp_down' && cmds[0]?.brand === '格力', summary(cmds));

cmds = parseVoice('把格力空调打开');
check('品牌提取', cmds[0]?.brand === '格力' && cmds[0]?.deviceType === 'ac' && cmds[0]?.action === 'power_on', summary(cmds));

cmds = parseVoice('换到5台', { lastDeviceType: 'tv' });
check('频道数字', cmds.some((c) => c.action === 'ch_set' && c.value === 5), summary(cmds));

cmds = parseVoice('打开风扇然后再把风速调小');
check('风扇+风速', cmds.length === 2 && cmds[0].deviceType === 'fan' && cmds[0].action === 'power_on' && cmds[1].action === 'fan_speed' && cmds[1].value === 'down', summary(cmds));

cmds = parseVoice('你好呀');
check('无法识别 → unknown', cmds.length === 1 && cmds[0].action === 'unknown', summary(cmds));

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
