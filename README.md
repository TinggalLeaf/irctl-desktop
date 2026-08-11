# 红外工具箱 irctl-desktop

跨平台串口红外收发工具箱。Tauri 2 + Vue 3 + TypeScript + Element Plus。

## 功能

- **启动硬件检测**：自动探测串口红外模块（E4 握手、多波特率扫描、容量探测），无硬件的功能入口置灰标注
- **状态看板**：硬件状态 / 发射功率档 / 今日发射次数 / 预设统计 / 码库版本 / 快捷入口 / 信号检测器
- **接收分析**：波形示波器（缩放/拖动/双游标测量）、30–56kHz 载波频谱、脉冲参数自动测量、Raw 视图与导出（JSON/CSV/Pronto/模块 HEX）、17 种协议自动识别（NEC 系列、RC-5/5X/6/6A、Sony SIRC 12/15/20、Panasonic Kaseikyo、Samsung、JVC、Sharp、Gree、Midea、Daikin、Pioneer、Denon）、一键存预设
- **红外发射**：预设管理（搜索/分类/分组）、点击与长按连发、软件功率增强（次数/间隔）、码库直达测试、序列/延时/循环发射、自定义模块 HEX 码
- **码库系统**：内置 1486 条离线码（67 品牌 × 11 品类）、品牌模糊搜索（支持别名）、「有反应」式智能匹配向导、在线码库（Kookong API，失败自动降级离线）
- **格式互转中心**：Pronto HEX / LIRC / Broadlink HEX & Base64 / Raw / JSON / XML / 模块 HEX 管道式互转（CyberChef 风格，可叠加多步管线）
- **AI 扩展中心**：OpenAI 兼容接口（自定义 Base URL / Key / 模型）、SSE 流式对话、10 个本地红外工具 function calling（编码生成/格式转换/协议逆向/载波估计等）
- **语音控制**：全品类中文指令解析、中文数字、组合指令、上下文继承、唤醒词（默认"小控"）；Web Speech API 不可用时降级手动输入
- **主题系统**：亮/暗/OLED 纯黑、7 套预设色板 + 自定义取色（主色自动派生梯度）、圆角/字号/动画速度微调
- **抗干扰**：毛刺过滤、±25% 可调容差、重复帧多数表决、载波频偏估计

## 硬件

串口红外转发模块（CH340，38kHz 载波，9600 8N1）。指令集 E0/E2/E3/E4/E7/E9/EA/EB/EC/FA/FB/FC/FD，详见 `docs/ARCHITECTURE.md`。模块 blob 格式：`[len_hi len_lo][data...][FF FF FF FF]`，data 为 100µs/字节的 mark/space 交替脉宽（已用真机数据校准）。

## 开发

```bash
pnpm install
pnpm tauri dev      # 开发（自动起 vite + 打开窗口）
pnpm build          # 前端构建（vue-tsc + vite）
cargo build         # src-tauri 内后端构建
./node_modules/.bin/vitest run   # 协议/互转/FFT 单元测试（48 例）
node scripts/gen-codelib.mjs     # 重新生成离线码库
```

## 结构

- `src-tauri/src/hardware.rs` — 串口硬件层（18 个 Tauri commands + 后台读线程 + 事件）
- `src/lib/protocol/` — 17 协议编解码 + 抗干扰
- `src/lib/convert/` — 格式互转管线（中枢 CanonicalSignal）
- `src/lib/codelib/` — 离线/在线码库 + 模糊搜索 + SmartMatcher
- `src/lib/ai/` `src/lib/voice/` — AI 流式客户端与工具、中文语音指令解析
- `src/assets/codes/codes.json` — 生成的离线码库（v1.0.0）
- `docs/ARCHITECTURE.md` — 完整架构契约
