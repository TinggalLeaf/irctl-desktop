# irctl-desktop 架构契约（所有子任务必须遵守）

跨平台红外工具箱。Tauri 2 + Vue 3 + TypeScript + Element Plus + vue-router + pinia + echarts + fuse.js。
UI 库固定 **Element Plus**；样式用 SCSS；全部界面中文。暗色/亮色主题。

## 硬件（已实测确认）

- 设备：串口红外收发模块（CH340，当前 COM3），载波固定 38kHz，TTL 串口。
- 串口参数：默认 9600 8N1（可切 19200/38400/57600/115200）。
- 指令集（hex，模块返回值 0xFF 表示错误）：
  - `E0 XX` 学习到编号 XX（1-248），学成返回 `E0`；学习中等按键，不发其他指令
  - `E2` 取消学习；`E3 XX` 发射编号 XX 的码，返回 `E3`（空返回 FF）
  - `E4` 测试，返回 `E4`（用于硬件探测/心跳）
  - `E7` 擦除全部；`E9 XX` 读编号 → 返回 blob
  - `EA XX <blob>` 写入编号，成功返回 `EA`
  - `EB` 学习并直接串口返回 blob（不入库），返回 `EB <blob>`
  - `EC <blob>` 直接发射 blob，成功返回 `EC`
  - `FA <no.> <delayS> <intervalS 1-5> <count> <slots...>` 设情景；`FB XX` 查情景；`FC AA XX` 上电情景（0 取消）；`FC BB` 查上电情景；`FD XX` 执行情景（执行中再发 `FD` 终止），完毕回 `FD`
- **红外码 blob 格式**：`[len_hi len_lo][data...][FF FF FF FF]`，len = 整个 blob 总字节数（含 2 字节长度与 4 字节 FF 结尾）。data 为模块私有脉宽编码（1 字节/边沿，~100µs 单位量级，精确单位待真机校准确认，代码中作为常量 `MODULE_TICK_US = 100` 可配置）。模块 blob 一律作为不透明格式透传存取。

## Rust 后端（src-tauri）

依赖：`serialport = "4"`。所有串口操作在 Rust 侧，通过 `tauri::async_runtime` + 后台读线程。
State：`SerialManager`（Mutex，含当前打开端口、读线程句柄、能力信息）。

Tauri commands（命名即函数名，参数 camelCase 由 serde 转换）：
- `list_serial_ports() -> Vec<PortInfo>`（port_name, friendly_name）
- `ir_detect(port_name?, baud?) -> HwCaps`：逐波特率发 E4 探测；返回 `{ port, baud, tx: true, rx: true, carrier_hz: 38000, slots: 248, emitters: 1 }`；slots 通过试读 E9 推断（1-12 有响应→片内款 12，否则 248 假设）。探测失败抛错。
- `ir_open(port_name, baud)` / `ir_close()`
- `ir_test() -> bool`（E4）
- `ir_learn_start(slot?) -> ()`：有 slot 发 `E0 slot`，无 slot 发 `EB`；立即返回，结果走事件
- `ir_learn_cancel()`（E2）
- `ir_transmit_slot(slot)`（E3）、`ir_read_slot(slot) -> Vec<u8> blob`（E9）、`ir_write_slot(slot, blob)`（EA）、`ir_transmit_blob(blob: Vec<u8>)`（EC）、`ir_erase_all()`（E7）
- `ir_scene_set(no, delay_s, interval_s, slots)` / `ir_scene_query(no)` / `ir_scene_set_power_on(no)` / `ir_scene_power_on_query()` / `ir_scene_run(no)` / `ir_scene_stop()`
- 事件（`app.emit`）：`ir:event` payload `{ kind: "learned", blob: number[] } | { kind: "ack", code: number } | { kind: "error", message } | { kind: "raw", bytes: number[] }`。读线程把模块一切返回解析后 emit。学习等待超时 30s 发 error。

## 前端结构

```
src/
  main.ts            # Element Plus 全量注册 + router + pinia + 主题初始化
  App.vue            # 左侧 el-menu 导航 + router-view + 全局硬件状态栏
  router/index.ts    # 路由：/dashboard /receive /transmit /library /convert /ai /voice /settings
  stores/            # pinia: hardware.ts(连接状态/能力/今日计数) presets.ts library.ts settings.ts stats.ts
  types/ir.ts        # 共享类型（见文件，已写好，禁止改签名）
  lib/
    hardware.ts      # invoke 封装 + 事件监听（已写好骨架）
    protocol/        # 17 协议解码 + 编码 + 抗干扰（pure TS，可 vitest）
    convert/         # Pronto/LIRC/Broadlink/Raw/JSON/XML 互转管线（pure TS）
    codelib/         # 离线码库查询 + 在线码库(Kookong API) + 模糊搜索 + 智能匹配
    fft.ts           # FFT（30-56kHz 载波频谱用，对脉宽序列做包络频谱估计）
    voice/           # 中文指令解析引擎（规则+模板，上下文继承，唤醒词）
    ai/              # OpenAI 兼容流式客户端 + 10 个本地 MCP 工具
  views/
    DashboardView.vue  ReceiveView.vue  TransmitView.vue  LibraryView.vue
    ConvertView.vue    AiView.vue       VoiceView.vue     SettingsView.vue
  components/        # 复用组件（示波器 ScopeCanvas.vue、频谱 FftChart.vue 等）
  styles/            # index.scss 主题变量、dark/light
  assets/codes/      # 离线码库 JSON（生成的 1000+ 条）
```

## 共享类型（src/types/ir.ts，已实现，各任务只读）

`IrBlob`（模块原始字节）、`PulseTrain`（µs 时间线，mark 起交替）、`DecodedFrame`（协议名/地址/命令/载波/额外字段）、`Preset`、`CodeEntry`、`HwCaps` 等。

## 核心算法要求

- **protocol/**：`decodeFrames(train: PulseTrain, opts?) -> DecodedFrame[]`。17 种协议：NEC、NECext、NEC42、RC5、RC5X、RC6、RC6A(mode0/6A)、Sony SIRC 12/15/20、Panasonic Kaseikyo、Samsung、JVC、Sharp、Gree、Midea、Daikin、Pioneer(可再加 Denon)。抗干扰：毛刺过滤（<80µs 脉冲吸收）、容差 ±25%、多帧多数表决、载波频偏估计。编码器 `encodeFrame(protocol, addr, cmd, opts) -> PulseTrain`。
- **convert/**：管线式 `convert(input: string, from: Format, to: Format) -> string`；格式：pronto、lirc、broadlink_hex、broadlink_b64、raw(µs 数组)、json、xml、module(模块 blob hex)。中枢表示 = `{ carrier_hz, pulses: number[] }`。Broadlink 含 0x26/0x00 包格式与 base64。Pronto 0000/0100。LIRC 文本解析。
- **codelib/**：离线 JSON（构建期生成 ≥1000 条，66 品牌 × 11 类设备 × 常用键，用真实协议参数合成 NEC/SIRC/RC5/Samsung/Panasonic 等码）；`searchBrand(fuse.js 模糊)`；`smartMatch(deviceType, brand, testFeedback)` 「有反应」式匹配引擎（逐码试发、用户点"有反应/无反应"收敛候选集）。在线码库：Kookong API client（base `http://sdk2.kookong.com`，appKey `E8A87CE67252443109C61029771A7143`，端点 `/m/brands` `/m/remotes` `/m/irs`，参考 E:/Projects/rehub/红外遥控/analysis/REPORT.md），结果缓存 localStorage，可关。
- **fft.ts**：radix-2 FFT；对 PulseTrain 生成 30-56kHz 包络频谱（重采样到 1MHz 后分段 FFT 或直接按 mark 内载波周期数估计）。
- **ai/**：OpenAI 兼容 `/chat/completions` SSE 流式；settings 存 baseUrl/apiKey/model。10 个本地工具：nec_encode、sirc_encode、rc5_encode、pronto_to_raw、raw_to_pronto、broadlink_decode、module_blob_to_raw、protocol_identify、pulse_measure、carrier_estimate —— 全部调本前端 protocol/convert 库，function calling 协议，本地执行回灌。
- **voice/**：Web Speech API（不可用时降级为文本输入框）；品类词表（空调/电视/投影仪/风扇/音响/机顶盒/DVD/灯…）、动作词、数值提取（温度/音量/频道）、组合指令（"然后/再/并且"切分）、上下文继承（缺品类沿用上次）、唤醒词（默认"小控"）。执行 = 查 presets/library → 调 hardware 发射。

## 页面要点

- Dashboard：硬件状态卡（端口/波特率/载波/容量）、发射功率档位显示、今日发射次数、预设统计、码库版本、快捷入口、信号检测器（迷你实时监测窗）。
- Receive：Canvas 示波器（滚轮缩放/拖动/游标测距）、FFT 频谱（30-56kHz）、脉冲参数自动测量表、Raw 视图与导出（JSON/CSV/Pronto）、17 协议自动识别列表、一键存预设。需硬件 RX；无 RX 时整页置灰标注。
- Transmit：预设管理（搜索/分类/分组树）、点击发射、长按连发（NEC repeat）、功率/增强档（软件层重复发送次数）、码库直达测试、序列编辑器（多步+延时+循环）。
- Library：离线/在线切换 Tab、品牌模糊搜索、设备分类、键码表、试发、「有反应」匹配向导。
- Convert：CyberChef 风格左侧输入右侧输出，格式下拉 + 自动识别 + 管线步骤可叠加。
- AI：对话窗（流式渲染）、工具调用气泡、设置面板（Base URL/Key/模型）。
- Voice：唤醒开关、识别状态、指令历史、上下文显示。
- Settings：串口（端口/波特率/自动重连）、发射（重复次数/间隔）、接收（容差/滤波）、主题（暗亮/OLED/7 色板/取色/圆角/字号/动画速度）、码库（在线开关/缓存清理）、AI、语音、关于（码库版本）。

## 主题系统

Element Plus CSS 变量覆写。`html.dark` 暗色；`html.oled` 纯黑(#000 背景)。7 套色板 + 自定义取色（Monet 风格：由主色派生 hover/light-3..9/dark-2）。圆角 `--el-border-radius-*`、字号、动画速度（全局 transition duration 变量）。settings store 持久化 localStorage。

## 验收

`pnpm build`（含 vue-tsc）必须通过；`cargo check` 通过；真机 COM3 联调：探测→学习→发射→读码闭环。
