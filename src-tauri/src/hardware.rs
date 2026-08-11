//! 串口红外模块硬件层
//!
//! 协议见 docs/ARCHITECTURE.md：CH340 串口模块，默认 9600 8N1，载波 38kHz，
//! 模块返回 0xFF 表示错误。所有命令返回 `Result<T, String>`，错误信息为中文。
//! 打开端口后由后台读线程统一读取模块返回，解析成帧后既投递给等待中的命令，
//! 也通过 `ir:event` 事件推给前端（payload 对应前端 IrEventPayload）。

use serde::Serialize;
use serialport::SerialPort;
use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// 模块 blob 时间单位（µs），待真机校准，前端同名义常量保持一致
pub const MODULE_TICK_US: u32 = 100;

const BAUD_CANDIDATES: [u32; 5] = [9600, 19200, 38400, 57600, 115200];
const CARRIER_HZ: u32 = 38000;
/// 普通写操作等待 ack 的超时
const ACK_TIMEOUT: Duration = Duration::from_millis(2000);
/// 擦除全片较慢，单独放宽
const ERASE_TIMEOUT: Duration = Duration::from_millis(5000);
/// 学习等待红外按键的超时（超时后经事件发 error）
const LEARN_TIMEOUT: Duration = Duration::from_secs(30);
/// 读线程单次 read 的阻塞上限（兼作停止标志/学习超时的巡检节拍）
const READ_POLL: Duration = Duration::from_millis(100);
/// FA/FB/FC 回显帧无固定长度，以接收空闲判定帧尾
const ECHO_IDLE: Duration = Duration::from_millis(150);
/// blob 帧数据不全时的停滞上限，超过则按 raw 冲刷防止死等
const FRAME_STALL: Duration = Duration::from_millis(1000);
const MAX_BLOB_LEN: usize = 2048;

// 指令码
const CMD_LEARN_SLOT: u8 = 0xE0;
const CMD_LEARN_CANCEL: u8 = 0xE2;
const CMD_TRANSMIT_SLOT: u8 = 0xE3;
const CMD_TEST: u8 = 0xE4;
const CMD_ERASE_ALL: u8 = 0xE7;
const CMD_READ_SLOT: u8 = 0xE9;
const CMD_WRITE_SLOT: u8 = 0xEA;
const CMD_LEARN_BLOB: u8 = 0xEB;
const CMD_TRANSMIT_BLOB: u8 = 0xEC;
const CMD_SCENE_SET: u8 = 0xFA;
const CMD_SCENE_QUERY: u8 = 0xFB;
const CMD_SCENE_POWER: u8 = 0xFC;
const CMD_SCENE_RUN: u8 = 0xFD;
const RESP_ERROR: u8 = 0xFF;

/// 硬件能力（serde camelCase → 前端 HwCaps）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HwCaps {
    pub port: String,
    pub baud: u32,
    pub tx: bool,
    pub rx: bool,
    pub carrier_hz: u32,
    pub slots: u32,
    pub emitters: u32,
}

/// 串口信息（serde camelCase → 前端 PortInfo）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub port_name: String,
    pub friendly_name: String,
}

/// 读线程解析出的模块返回帧
#[derive(Clone, Debug)]
enum Frame {
    /// 单字节确认（E0/E3/E4/E7/EA/EC/FD 等原样回送）
    Ack(u8),
    /// E9/EB 前缀 + blob（blob 不含前缀，含 2 字节长度与 FF FF FF FF 结尾）
    Blob { prefix: u8, blob: Vec<u8> },
    /// FA/FB/FC 回显帧（data 不含前缀，长度不定，按接收空闲切帧）
    Echo { prefix: u8, data: Vec<u8> },
    /// 模块返回 0xFF，表示错误
    Error,
    /// 无法识别的字节
    Raw(Vec<u8>),
}

struct Shared {
    /// 写句柄（读线程持有 try_clone 出的读句柄）
    port: Option<Box<dyn SerialPort>>,
    port_name: Option<String>,
    baud: u32,
    /// ir_detect 成功后缓存的能力信息
    caps: Option<HwCaps>,
    /// 读线程投递的帧队列，命令按谓词取走匹配帧
    inbox: VecDeque<Frame>,
    stop: bool,
    reader: Option<JoinHandle<()>>,
    /// 学习超时截止点（E0/EB 发出后设置，学成/取消/超时清除）
    learn_deadline: Option<Instant>,
}

struct SerialShared {
    inner: Mutex<Shared>,
    cond: Condvar,
    /// 串行化各个写命令，避免并发 invoke 互相清队列
    op: Mutex<()>,
}

/// Tauri 全局状态（`.manage(SerialManager::new())`）
#[derive(Clone)]
pub struct SerialManager {
    shared: Arc<SerialShared>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(SerialShared {
                inner: Mutex::new(Shared {
                    port: None,
                    port_name: None,
                    baud: 9600,
                    caps: None,
                    inbox: VecDeque::new(),
                    stop: false,
                    reader: None,
                    learn_deadline: None,
                }),
                cond: Condvar::new(),
                op: Mutex::new(()),
            }),
        }
    }

    /// 停掉读线程：置标志后取出句柄再 join（不能在持锁状态下 join）
    fn stop_reader(&self) {
        let handle = {
            let mut g = self.shared.inner.lock().unwrap();
            g.stop = true;
            g.reader.take()
        };
        if let Some(h) = handle {
            let _ = h.join();
        }
    }
}

fn emit_event(app: &AppHandle, payload: serde_json::Value) {
    if let Err(e) = app.emit("ir:event", payload) {
        eprintln!("emit ir:event 失败：{e}");
    }
}

/// 帧投递：入 inbox 唤醒等待中的命令，同时 emit 事件；学成帧清除学习超时
fn dispatch_frame(app: &AppHandle, shared: &SerialShared, frame: Frame) {
    let payload = match &frame {
        Frame::Ack(code) => serde_json::json!({ "kind": "ack", "code": code }),
        Frame::Blob { prefix, blob } => {
            if *prefix == CMD_LEARN_BLOB {
                serde_json::json!({ "kind": "learned", "blob": blob })
            } else {
                // E9 读槽结果走 invoke 返回值，事件侧按 raw 透出
                serde_json::json!({ "kind": "raw", "bytes": blob })
            }
        }
        Frame::Echo { prefix, data } => {
            let mut bytes = vec![*prefix];
            bytes.extend_from_slice(data);
            serde_json::json!({ "kind": "raw", "bytes": bytes })
        }
        Frame::Error => serde_json::json!({ "kind": "error", "message": "模块返回错误（0xFF）" }),
        Frame::Raw(bytes) => serde_json::json!({ "kind": "raw", "bytes": bytes }),
    };
    {
        let mut g = shared.inner.lock().unwrap();
        match &frame {
            Frame::Ack(CMD_LEARN_SLOT) => g.learn_deadline = None,
            Frame::Blob { prefix, .. } if *prefix == CMD_LEARN_BLOB => g.learn_deadline = None,
            _ => {}
        }
        g.inbox.push_back(frame);
    }
    shared.cond.notify_all();
    emit_event(app, payload);
}

/// 从接收缓冲区尽力解析帧；不完整帧保留等待后续数据，停滞超时按 raw 冲刷
fn parse_buffer(app: &AppHandle, shared: &SerialShared, buf: &mut Vec<u8>, last_data: Instant) {
    loop {
        let Some(&b0) = buf.first() else { return };
        match b0 {
            CMD_READ_SLOT | CMD_LEARN_BLOB => {
                if buf.len() < 3 {
                    if last_data.elapsed() > FRAME_STALL {
                        let raw = std::mem::take(buf);
                        dispatch_frame(app, shared, Frame::Raw(raw));
                    }
                    return; // 等长度字节
                }
                let len = ((buf[1] as usize) << 8) | buf[2] as usize;
                if !(6..=MAX_BLOB_LEN).contains(&len) {
                    // 长度非法：失步，丢弃首字节按 raw 透出后继续对齐
                    let byte = buf.remove(0);
                    dispatch_frame(app, shared, Frame::Raw(vec![byte]));
                    continue;
                }
                let total = 1 + len; // 前缀 + blob（len 含长度字节自身）
                if buf.len() < total {
                    if last_data.elapsed() > FRAME_STALL {
                        let raw = std::mem::take(buf);
                        dispatch_frame(app, shared, Frame::Raw(raw));
                    }
                    return; // 等数据字节
                }
                let blob: Vec<u8> = buf[1..total].to_vec();
                buf.drain(..total);
                dispatch_frame(app, shared, Frame::Blob { prefix: b0, blob });
            }
            CMD_SCENE_SET | CMD_SCENE_QUERY | CMD_SCENE_POWER => {
                // 回显帧：接收空闲 ECHO_IDLE 即视为帧尾
                if last_data.elapsed() >= ECHO_IDLE {
                    let data: Vec<u8> = buf[1..].to_vec();
                    buf.clear();
                    dispatch_frame(app, shared, Frame::Echo { prefix: b0, data });
                }
                return;
            }
            RESP_ERROR => {
                buf.remove(0);
                dispatch_frame(app, shared, Frame::Error);
            }
            // E9 读槽应答为无前缀帧（真机实测）：[len_hi len_lo][data][FF FF FF FF]，
            // len 含长度字节自身；len_hi ≤ 0x08（MAX_BLOB_LEN=2048），与指令/ack 字节（≥0xE0）无冲突
            0x00..=0x08 => {
                if buf.len() < 2 {
                    if last_data.elapsed() > FRAME_STALL {
                        let raw = std::mem::take(buf);
                        dispatch_frame(app, shared, Frame::Raw(raw));
                    }
                    return; // 等长度低字节
                }
                let len = ((buf[0] as usize) << 8) | buf[1] as usize;
                if !(6..=MAX_BLOB_LEN).contains(&len) {
                    let byte = buf.remove(0);
                    dispatch_frame(app, shared, Frame::Raw(vec![byte]));
                    continue;
                }
                if buf.len() < len {
                    if last_data.elapsed() > FRAME_STALL {
                        let raw = std::mem::take(buf);
                        dispatch_frame(app, shared, Frame::Raw(raw));
                    }
                    return; // 等数据字节
                }
                if buf[len - 4..len] != [0xFF, 0xFF, 0xFF, 0xFF] {
                    // 结尾校验失败：失步，丢弃首字节继续对齐
                    let byte = buf.remove(0);
                    dispatch_frame(app, shared, Frame::Raw(vec![byte]));
                    continue;
                }
                let blob: Vec<u8> = buf[..len].to_vec();
                buf.drain(..len);
                // 无前缀 blob：学习进行中按 EB 学成帧投递，否则按 E9 读槽帧投递
                let prefix = if shared.inner.lock().unwrap().learn_deadline.is_some() {
                    CMD_LEARN_BLOB
                } else {
                    CMD_READ_SLOT
                };
                dispatch_frame(app, shared, Frame::Blob { prefix, blob });
            }
            other => {
                buf.remove(0);
                dispatch_frame(app, shared, Frame::Ack(other));
            }
        }
    }
}

fn reader_loop(app: AppHandle, shared: Arc<SerialShared>, mut port: Box<dyn SerialPort>) {
    let mut buf: Vec<u8> = Vec::new();
    let mut last_data = Instant::now();
    loop {
        {
            let g = shared.inner.lock().unwrap();
            if g.stop {
                break;
            }
        }
        let mut chunk = [0u8; 1024];
        match port.read(&mut chunk) {
            Ok(n) if n > 0 => {
                buf.extend_from_slice(&chunk[..n]);
                last_data = Instant::now();
            }
            Ok(_) => {}
            Err(ref e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {}
            Err(e) => {
                emit_event(
                    &app,
                    serde_json::json!({ "kind": "error", "message": format!("串口读取失败：{e}") }),
                );
                break;
            }
        }
        // 学习超时巡检
        let mut timeout_hit = false;
        {
            let mut g = shared.inner.lock().unwrap();
            if let Some(deadline) = g.learn_deadline {
                if Instant::now() >= deadline {
                    g.learn_deadline = None;
                    timeout_hit = true;
                }
            }
        }
        if timeout_hit {
            // 同步取消模块侧学习态：模块在学习中只认 E2，不取消会卡住后续所有指令
            {
                let mut g = shared.inner.lock().unwrap();
                if let Some(port) = g.port.as_mut() {
                    let _ = port.write_all(&[CMD_LEARN_CANCEL]);
                    let _ = port.flush();
                }
            }
            emit_event(
                &app,
                serde_json::json!({ "kind": "error", "message": "学习超时：30 秒内未收到红外按键信号" }),
            );
        }
        parse_buffer(&app, &shared, &mut buf, last_data);
    }
}

/// 写命令并等待匹配帧；inbox 中先到的 0xFF 一律视为本命令失败
fn write_and_wait<F>(
    shared: &SerialShared,
    bytes: &[u8],
    pred: F,
    timeout: Duration,
) -> Result<Frame, String>
where
    F: Fn(&Frame) -> bool,
{
    let deadline = Instant::now() + timeout;
    let mut g = shared.inner.lock().unwrap();
    if g.port.is_none() {
        return Err("串口未打开，请先连接红外模块".to_string());
    }
    g.inbox.clear();
    {
        let port = g.port.as_mut().unwrap();
        port.write_all(bytes)
            .map_err(|e| format!("串口写入失败：{e}"))?;
        let _ = port.flush();
    }
    loop {
        if let Some(pos) = g
            .inbox
            .iter()
            .position(|f| matches!(f, Frame::Error) || pred(f))
        {
            let frame = g.inbox.remove(pos).unwrap();
            return match frame {
                Frame::Error => Err("模块返回错误（0xFF）：操作失败或目标槽位为空".to_string()),
                other => Ok(other),
            };
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("等待模块响应超时".to_string());
        }
        let (guard, _) = shared.cond.wait_timeout(g, deadline - now).unwrap();
        g = guard;
    }
}

/// 只写不等（学习/情景执行等结果走事件的命令）
fn write_only(shared: &SerialShared, bytes: &[u8]) -> Result<(), String> {
    let mut g = shared.inner.lock().unwrap();
    if g.port.is_none() {
        return Err("串口未打开，请先连接红外模块".to_string());
    }
    g.inbox.clear();
    let port = g.port.as_mut().unwrap();
    port.write_all(bytes)
        .map_err(|e| format!("串口写入失败：{e}"))?;
    let _ = port.flush();
    Ok(())
}

fn check_slot(slot: u8) -> Result<(), String> {
    if !(1..=248).contains(&slot) {
        return Err(format!("槽位编号必须在 1-248 之间，收到 {slot}"));
    }
    Ok(())
}

/// 校验 blob 格式：[len_hi len_lo][data...][FF FF FF FF]，len 含长度字节自身
fn check_blob(blob: &[u8]) -> Result<(), String> {
    if blob.len() < 6 {
        return Err("红外码 blob 太短：至少需要 2 字节长度 + 4 字节 FF 结尾".to_string());
    }
    let declared = ((blob[0] as usize) << 8) | blob[1] as usize;
    if declared != blob.len() {
        return Err(format!(
            "红外码 blob 长度字段（{declared}）与实际字节数（{}）不一致",
            blob.len()
        ));
    }
    Ok(())
}

fn open_port(port_name: &str, baud: u32, timeout: Duration) -> Result<Box<dyn SerialPort>, String> {
    serialport::new(port_name, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(timeout)
        .open()
        .map_err(|e| format!("打开串口 {port_name} 失败：{e}"))
}

fn read_byte(port: &mut Box<dyn SerialPort>, timeout: Duration) -> Option<u8> {
    let deadline = Instant::now() + timeout;
    let mut b = [0u8; 1];
    loop {
        match port.read(&mut b) {
            Ok(1) => return Some(b[0]),
            Ok(_) => {}
            Err(ref e) if e.kind() == ErrorKind::TimedOut || e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            return None;
        }
    }
}

/// 在指定端口/波特率上发 E4 试探测，成功再探测容量
fn try_detect_port(port_name: &str, baud: u32) -> Option<HwCaps> {
    let mut port = open_port(port_name, baud, Duration::from_millis(300)).ok()?;
    let _ = port.clear(serialport::ClearBuffer::All);
    port.write_all(&[CMD_TEST]).ok()?;
    let _ = port.flush();
    if read_byte(&mut port, Duration::from_millis(600)) != Some(CMD_TEST) {
        return None;
    }
    // 容量探测：读 13 号槽，FF → 片内 12 槽款；返回 blob → 248 槽款；其余按 248 假设
    let _ = port.clear(serialport::ClearBuffer::All);
    let mut slots = 248;
    if port.write_all(&[CMD_READ_SLOT, 13]).is_ok() {
        let _ = port.flush();
        if let Some(first) = read_byte(&mut port, Duration::from_millis(800)) {
            if first == RESP_ERROR {
                slots = 12;
            }
        }
    }
    Some(HwCaps {
        port: port_name.to_string(),
        baud,
        tx: true,
        rx: true,
        carrier_hz: CARRIER_HZ,
        slots,
        emitters: 1,
    })
}

// ---------------- Tauri commands ----------------

#[tauri::command]
pub async fn list_serial_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("枚举串口失败：{e}"))?;
    Ok(ports
        .into_iter()
        .map(|p| {
            let friendly_name = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => info
                    .product
                    .clone()
                    .or_else(|| info.manufacturer.clone())
                    .unwrap_or_else(|| "USB 串口设备".to_string()),
                serialport::SerialPortType::BluetoothPort => "蓝牙串口".to_string(),
                serialport::SerialPortType::PciPort => "PCI 串口".to_string(),
                serialport::SerialPortType::Unknown => "未知串口设备".to_string(),
            };
            PortInfo {
                port_name: p.port_name,
                friendly_name,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn ir_detect(
    state: State<'_, SerialManager>,
    port_name: Option<String>,
    baud: Option<u32>,
) -> Result<HwCaps, String> {
    let candidates: Vec<String> = match port_name {
        Some(p) => vec![p],
        None => serialport::available_ports()
            .map_err(|e| format!("枚举串口失败：{e}"))?
            .into_iter()
            .map(|p| p.port_name)
            .collect(),
    };
    let bauds: Vec<u32> = match baud {
        Some(b) => vec![b],
        None => BAUD_CANDIDATES.to_vec(),
    };
    for port in &candidates {
        for b in &bauds {
            if let Some(caps) = try_detect_port(port, *b) {
                state.shared.inner.lock().unwrap().caps = Some(caps.clone());
                return Ok(caps);
            }
        }
    }
    Err("未检测到红外模块".to_string())
}

#[tauri::command]
pub async fn ir_open(
    app: AppHandle,
    state: State<'_, SerialManager>,
    port_name: String,
    baud: u32,
) -> Result<(), String> {
    // 先释放已有连接
    state.stop_reader();
    {
        let mut g = state.shared.inner.lock().unwrap();
        g.port = None;
    }
    let port = open_port(&port_name, baud, READ_POLL)?;
    let reader_port = port
        .try_clone()
        .map_err(|e| format!("克隆串口句柄失败：{e}"))?;
    let shared = state.shared.clone();
    let app2 = app.clone();
    let handle = std::thread::spawn(move || reader_loop(app2, shared, reader_port));
    let mut g = state.shared.inner.lock().unwrap();
    g.port = Some(port);
    g.port_name = Some(port_name);
    g.baud = baud;
    g.stop = false;
    g.reader = Some(handle);
    g.inbox.clear();
    g.learn_deadline = None;
    // 模块可能滞留在学习态（此前异常退出/超时未取消），学习中只认 E2，先取消其卡死状态
    if let Some(port) = g.port.as_mut() {
        let _ = port.write_all(&[CMD_LEARN_CANCEL]);
        let _ = port.flush();
    }
    Ok(())
}

#[tauri::command]
pub async fn ir_close(state: State<'_, SerialManager>) -> Result<(), String> {
    state.stop_reader();
    let mut g = state.shared.inner.lock().unwrap();
    g.port = None;
    g.port_name = None;
    g.learn_deadline = None;
    g.inbox.clear();
    Ok(())
}

#[tauri::command]
pub async fn ir_test(state: State<'_, SerialManager>) -> Result<bool, String> {
    let _op = state.shared.op.lock().unwrap();
    write_and_wait(
        &state.shared,
        &[CMD_TEST],
        |f| matches!(f, Frame::Ack(CMD_TEST)),
        ACK_TIMEOUT,
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn ir_learn_start(state: State<'_, SerialManager>, slot: Option<u8>) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    let bytes = match slot {
        Some(s) => {
            check_slot(s)?;
            vec![CMD_LEARN_SLOT, s]
        }
        None => vec![CMD_LEARN_BLOB],
    };
    write_only(&state.shared, &bytes)?;
    state.shared.inner.lock().unwrap().learn_deadline = Some(Instant::now() + LEARN_TIMEOUT);
    // 立即返回，学习结果（E0 ack / EB+blob / 30s 超时 error）经 ir:event 推送
    Ok(())
}

#[tauri::command]
pub async fn ir_learn_cancel(state: State<'_, SerialManager>) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    write_only(&state.shared, &[CMD_LEARN_CANCEL])?;
    state.shared.inner.lock().unwrap().learn_deadline = None;
    Ok(())
}

#[tauri::command]
pub async fn ir_transmit_slot(state: State<'_, SerialManager>, slot: u8) -> Result<(), String> {
    check_slot(slot)?;
    let _op = state.shared.op.lock().unwrap();
    write_and_wait(
        &state.shared,
        &[CMD_TRANSMIT_SLOT, slot],
        |f| matches!(f, Frame::Ack(CMD_TRANSMIT_SLOT)),
        ACK_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_read_slot(state: State<'_, SerialManager>, slot: u8) -> Result<Vec<u8>, String> {
    check_slot(slot)?;
    let _op = state.shared.op.lock().unwrap();
    let frame = write_and_wait(
        &state.shared,
        &[CMD_READ_SLOT, slot],
        |f| matches!(f, Frame::Blob { prefix, .. } if *prefix == CMD_READ_SLOT),
        ACK_TIMEOUT,
    )?;
    match frame {
        Frame::Blob { blob, .. } => Ok(blob),
        _ => Err("模块响应格式异常".to_string()),
    }
}

#[tauri::command]
pub async fn ir_write_slot(
    state: State<'_, SerialManager>,
    slot: u8,
    blob: Vec<u8>,
) -> Result<(), String> {
    check_slot(slot)?;
    check_blob(&blob)?;
    let _op = state.shared.op.lock().unwrap();
    let mut bytes = vec![CMD_WRITE_SLOT, slot];
    bytes.extend_from_slice(&blob);
    write_and_wait(
        &state.shared,
        &bytes,
        |f| matches!(f, Frame::Ack(CMD_WRITE_SLOT)),
        ACK_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_transmit_blob(state: State<'_, SerialManager>, blob: Vec<u8>) -> Result<(), String> {
    check_blob(&blob)?;
    let _op = state.shared.op.lock().unwrap();
    let mut bytes = vec![CMD_TRANSMIT_BLOB];
    bytes.extend_from_slice(&blob);
    write_and_wait(
        &state.shared,
        &bytes,
        |f| matches!(f, Frame::Ack(CMD_TRANSMIT_BLOB)),
        ACK_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_erase_all(state: State<'_, SerialManager>) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    write_and_wait(
        &state.shared,
        &[CMD_ERASE_ALL],
        |f| matches!(f, Frame::Ack(CMD_ERASE_ALL)),
        ERASE_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_scene_set(
    state: State<'_, SerialManager>,
    no: u8,
    delay_s: u8,
    interval_s: u8,
    slots: Vec<u8>,
) -> Result<(), String> {
    if !(1..=5).contains(&interval_s) {
        return Err(format!("情景间隔必须在 1-5 秒之间，收到 {interval_s}"));
    }
    if slots.is_empty() {
        return Err("情景槽位列表不能为空".to_string());
    }
    if slots.len() > 255 {
        return Err("情景槽位数量超过 255 上限".to_string());
    }
    let _op = state.shared.op.lock().unwrap();
    let mut bytes = vec![CMD_SCENE_SET, no, delay_s, interval_s, slots.len() as u8];
    bytes.extend_from_slice(&slots);
    write_and_wait(
        &state.shared,
        &bytes,
        |f| matches!(f, Frame::Echo { prefix, .. } if *prefix == CMD_SCENE_SET),
        ACK_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_scene_query(state: State<'_, SerialManager>, no: u8) -> Result<Vec<u8>, String> {
    let _op = state.shared.op.lock().unwrap();
    let frame = write_and_wait(
        &state.shared,
        &[CMD_SCENE_QUERY, no],
        |f| matches!(f, Frame::Echo { prefix, .. } if *prefix == CMD_SCENE_QUERY),
        ACK_TIMEOUT,
    )?;
    match frame {
        Frame::Echo { data, .. } => Ok(data),
        _ => Err("模块响应格式异常".to_string()),
    }
}

#[tauri::command]
pub async fn ir_scene_set_power_on(state: State<'_, SerialManager>, no: u8) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    write_and_wait(
        &state.shared,
        &[CMD_SCENE_POWER, 0xAA, no],
        |f| matches!(f, Frame::Echo { prefix, .. } if *prefix == CMD_SCENE_POWER),
        ACK_TIMEOUT,
    )?;
    Ok(())
}

#[tauri::command]
pub async fn ir_scene_power_on_query(state: State<'_, SerialManager>) -> Result<u8, String> {
    let _op = state.shared.op.lock().unwrap();
    let frame = write_and_wait(
        &state.shared,
        &[CMD_SCENE_POWER, 0xBB],
        |f| matches!(f, Frame::Echo { prefix, .. } if *prefix == CMD_SCENE_POWER),
        ACK_TIMEOUT,
    )?;
    match frame {
        // 回显可能是 FC BB <no> 或 FC <no>，取末字节最稳；0 表示未设置
        Frame::Echo { data, .. } => Ok(data.last().copied().unwrap_or(0)),
        _ => Err("模块响应格式异常".to_string()),
    }
}

#[tauri::command]
pub async fn ir_scene_run(state: State<'_, SerialManager>, no: u8) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    // 执行期间模块不响应属正常，完毕后的 FD 由读线程经事件推送，这里不等 ack
    write_only(&state.shared, &[CMD_SCENE_RUN, no])?;
    Ok(())
}

#[tauri::command]
pub async fn ir_scene_stop(state: State<'_, SerialManager>) -> Result<(), String> {
    let _op = state.shared.op.lock().unwrap();
    // 执行中再发 FD 即终止
    write_only(&state.shared, &[CMD_SCENE_RUN])?;
    Ok(())
}
