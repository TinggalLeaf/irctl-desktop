<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { AI_TOOLS, executeTool, streamChat } from '../lib/ai';
import type { ChatMessage } from '../lib/ai';
import { useSettingsStore } from '../stores/settings';

defineOptions({ name: 'AiView' });

const router = useRouter();
const settings = useSettingsStore();

/* ---------------- 配置 ---------------- */
const cfgOpen = ref<string[]>([]);
const configured = computed(
  () =>
    Boolean(settings.ai.apiKey.trim()) &&
    Boolean(settings.ai.baseUrl.trim()) &&
    Boolean(settings.ai.model.trim()),
);

function saveConfig() {
  // settings store 已 watch 自动持久化，这里给出显式反馈
  ElMessage.success('AI 配置已保存');
}

/* ---------------- 消息模型 ---------------- */
interface ToolCallUi {
  id: string;
  name: string;
  argsPretty: string;
  result: string;
  running: boolean;
}
interface UiMsg {
  id: number;
  role: 'user' | 'assistant' | 'note';
  content: string;
  streaming?: boolean;
  toolCalls: ToolCallUi[];
}

const SYS_PROMPT =
  '你是红外遥控工具箱内置的 AI 助手，擅长红外协议（NEC/RC5/SIRC/Broadlink/Pronto 等）分析、编码与格式互转。' +
  '回答一律使用中文。需要编码、解码、协议识别、参数测量或载波估计时，优先调用提供的本地工具，并基于工具结果作答。';

let msgSeq = 0;
const messages = ref<UiMsg[]>([]);
const input = ref('');
const busy = ref(false);
const chatEl = ref<HTMLElement | null>(null);
let abortCtl: AbortController | null = null;
/** 发送给 API 的完整消息链（含 tool 回灌） */
let apiMessages: ChatMessage[] = [{ role: 'system', content: SYS_PROMPT }];

const MAX_TOOL_ROUNDS = 5;

function scrollBottom() {
  void nextTick(() => {
    const el = chatEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw || '{}';
  }
}

/** 工具结果摘要（界面展示截断，完整结果仍回灌模型） */
function summarizeResult(res: string): string {
  return res.length > 800 ? `${res.slice(0, 800)}…（共 ${res.length} 字符）` : res;
}

/* ---------------- 简易 markdown 渲染（代码块 / 行内代码 / 粗体 / 换行） ---------------- */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMd(src: string): string {
  const blocks: string[] = [];
  let html = escapeHtml(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(code.replace(/\n$/, ''));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  html = html
    .replace(/`([^`\n]+)`/g, '<code class="md-inline">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  return html.replace(
    /\u0000(\d+)\u0000/g,
    (_m, i: string) => `<pre class="md-pre"><code>${blocks[Number(i)]}</code></pre>`,
  );
}

/* ---------------- 发送 / 工具调用循环 ---------------- */
async function send() {
  const text = input.value.trim();
  if (!text || busy.value) return;
  if (!configured.value) {
    cfgOpen.value = ['cfg'];
    ElMessage.warning('请先配置 Base URL / API Key / 模型');
    return;
  }
  input.value = '';
  messages.value.push({ id: ++msgSeq, role: 'user', content: text, toolCalls: [] });
  apiMessages.push({ role: 'user', content: text });
  busy.value = true;
  abortCtl = new AbortController();
  scrollBottom();

  try {
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const ui: UiMsg = { id: ++msgSeq, role: 'assistant', content: '', streaming: true, toolCalls: [] };
      messages.value.push(ui);
      scrollBottom();

      const result = await streamChat({
        baseUrl: settings.ai.baseUrl,
        apiKey: settings.ai.apiKey,
        model: settings.ai.model,
        messages: [...apiMessages],
        signal: abortCtl.signal,
        onDelta: (d) => {
          ui.content += d;
          scrollBottom();
        },
      });
      ui.streaming = false;

      if (!result.toolCalls.length) {
        apiMessages.push({ role: 'assistant', content: result.content });
        break;
      }

      // 模型要求调用工具 → 本地执行 → 结果回灌，继续下一轮流式
      apiMessages.push({ role: 'assistant', content: result.content, tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        const tui: ToolCallUi = {
          id: tc.id,
          name: tc.function.name,
          argsPretty: prettyArgs(tc.function.arguments),
          result: '',
          running: true,
        };
        ui.toolCalls.push(tui);
        scrollBottom();

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          /* 参数 JSON 异常时按空参数执行，由工具侧返回 error 让模型自愈 */
        }
        const res = await executeTool(tc.function.name, args);
        tui.result = summarizeResult(res);
        tui.running = false;
        apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: res });
        scrollBottom();
      }

      if (round === MAX_TOOL_ROUNDS) {
        messages.value.push({
          id: ++msgSeq,
          role: 'note',
          content: `已达到工具调用上限（${MAX_TOOL_ROUNDS} 轮），停止继续调用工具。`,
          toolCalls: [],
        });
      }
    }
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') {
      messages.value.push({ id: ++msgSeq, role: 'note', content: '已手动停止生成。', toolCalls: [] });
    } else {
      messages.value.push({
        id: ++msgSeq,
        role: 'note',
        content: `请求失败：${err.message}`,
        toolCalls: [],
      });
    }
  } finally {
    busy.value = false;
    abortCtl = null;
    scrollBottom();
  }
}

function stop() {
  abortCtl?.abort();
}

function clearAll() {
  if (busy.value) stop();
  messages.value = [];
  apiMessages = [{ role: 'system', content: SYS_PROMPT }];
}

/* ---------------- 工具侧栏 ---------------- */
const TOOL_EXAMPLES: Record<string, string> = {
  nec_encode: '帮我用 NEC 协议编码地址 0x0707、命令 0x02 的红外码',
  sirc_encode: '用 Sony SIRC-12 编码地址 1、命令 0x15（电源键）的红外码',
  rc5_encode: '用 Philips RC5 协议编码系统地址 0、命令 0x0C（电源）',
  pronto_to_raw: '把这段 Pronto 转成 raw：0000 006D 0002 0000 0157 00AC 0015 0040 0015 0E94',
  raw_to_pronto: '把这段 raw 转成 Pronto：9000 4500 560 560 560 1690 560 560',
  broadlink_decode:
    '解码这个 Broadlink 码：JgBGAJKVETkRORA6EBYRFBEUEBUQFDkUNhQ3FDYUNhQ2FDYUNhQRFBEUERQRFBE4ETkRORE5ETkRORE5ERUROREUEBQRFBEUEBQRFBEUEBQRORE5ETkSNxE5ETkRORA6EBYRFBAADQUAAA==',
  module_blob_to_raw: '把这个模块 blob 解成脉宽：00 49 5A 2D 08 08 08 15 08 08 08 08 FF FF FF FF',
  protocol_identify: '识别这段脉宽是什么协议：9000, 4500, 560, 560, 560, 1690, 560, 1690, 560, 560',
  pulse_measure: '测量这段脉宽的参数：9000, 4500, 560, 560, 560, 1690, 560, 560, 560',
  carrier_estimate: '估计这段信号的载波频率：9000, 4500, 560, 560, 560, 1690, 560, 560',
};

function insertExample(name: string) {
  input.value = TOOL_EXAMPLES[name] ?? `请使用 ${name} 工具演示一下`;
}
</script>

<template>
  <div class="ai-view">
    <!-- 配置卡（可折叠） -->
    <el-card shadow="never">
      <el-collapse v-model="cfgOpen">
        <el-collapse-item name="cfg">
          <template #title>
            <span class="cfg-title">模型配置</span>
            <el-tag
              size="small"
              :type="configured ? 'success' : 'warning'"
              effect="plain"
              class="cfg-tag"
            >
              {{ configured ? '已配置' : '未配置' }}
            </el-tag>
          </template>
          <el-form label-width="90px" class="cfg-form">
            <el-form-item label="Base URL">
              <el-input v-model="settings.ai.baseUrl" placeholder="https://api.openai.com/v1" />
            </el-form-item>
            <el-form-item label="API Key">
              <el-input
                v-model="settings.ai.apiKey"
                type="password"
                show-password
                placeholder="sk-..."
              />
            </el-form-item>
            <el-form-item label="模型">
              <el-input v-model="settings.ai.model" placeholder="gpt-4o-mini" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" size="small" @click="saveConfig">保存</el-button>
              <span class="text-secondary cfg-hint">修改会自动持久化到本地，点击保存仅作确认</span>
            </el-form-item>
          </el-form>
        </el-collapse-item>
      </el-collapse>
      <el-alert
        v-if="!configured"
        type="warning"
        :closable="false"
        show-icon
        class="cfg-alert"
        title="尚未配置 AI 服务，无法开始对话"
      >
        <template #default>
          请展开上方「模型配置」填写 Base URL / API Key / 模型，或前往
          <el-button text type="primary" size="small" @click="router.push('/settings')">设置页</el-button>
          完成配置。
        </template>
      </el-alert>
    </el-card>

    <el-row :gutter="16" class="main-row">
      <!-- 对话区 -->
      <el-col :span="17">
        <el-card shadow="never" class="chat-card">
          <template #header>
            <div class="card-header">
              <span>对话</span>
              <el-button
                size="small"
                text
                type="danger"
                :disabled="!messages.length"
                @click="clearAll"
              >清空对话</el-button>
            </div>
          </template>

          <div ref="chatEl" class="msg-list">
            <el-empty
              v-if="!messages.length"
              description="输入问题开始对话，点击右侧工具可插入示例提问"
              :image-size="80"
            />
            <template v-for="m in messages" :key="m.id">
              <!-- 用户气泡 -->
              <div v-if="m.role === 'user'" class="msg-row user">
                <div class="bubble user-bubble">{{ m.content }}</div>
              </div>
              <!-- 系统提示（停止 / 错误 / 上限） -->
              <div v-else-if="m.role === 'note'" class="msg-row">
                <div class="note-bubble">{{ m.content }}</div>
              </div>
              <!-- AI 气泡 -->
              <div v-else class="msg-row">
                <div class="bubble ai-bubble">
                  <div v-if="m.content" class="md" v-html="renderMd(m.content)"></div>
                  <div v-if="m.streaming && !m.content" class="text-secondary">正在生成…</div>
                  <span v-if="m.streaming && m.content" class="cursor">▍</span>
                  <!-- 工具调用气泡 -->
                  <div v-for="t in m.toolCalls" :key="t.id" class="tool-call">
                    <div class="tc-head">
                      <el-tag size="small" type="warning" effect="plain">工具调用</el-tag>
                      <span class="mono tc-name">{{ t.name }}</span>
                      <el-tag v-if="t.running" size="small" type="info" effect="plain">执行中…</el-tag>
                      <el-tag v-else size="small" type="success" effect="plain">已完成</el-tag>
                    </div>
                    <div class="tc-block">
                      <span class="tc-label text-secondary">参数</span>
                      <pre class="mono tc-pre">{{ t.argsPretty }}</pre>
                    </div>
                    <div v-if="t.result" class="tc-block">
                      <span class="tc-label text-secondary">本地执行结果</span>
                      <pre class="mono tc-pre">{{ t.result }}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- 输入区 -->
          <div class="input-bar">
            <el-input
              v-model="input"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 6 }"
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              @keydown.enter.exact.prevent="send"
            />
            <div class="input-actions">
              <el-button v-if="busy" type="danger" @click="stop">停止</el-button>
              <el-button v-else type="primary" :disabled="!input.trim()" @click="send">发送</el-button>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 内置工具侧栏 -->
      <el-col :span="7">
        <el-card shadow="never" class="tools-card">
          <template #header>
            <span>内置工具（{{ AI_TOOLS.length }}）</span>
          </template>
          <div class="tool-list">
            <div
              v-for="t in AI_TOOLS"
              :key="t.name"
              class="tool-item"
              title="点击插入示例提问"
              @click="insertExample(t.name)"
            >
              <div class="tool-name mono">{{ t.name }}</div>
              <div class="tool-desc text-secondary">{{ t.description }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped lang="scss">
.ai-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cfg-title {
  font-weight: 600;
}

.cfg-tag {
  margin-left: 8px;
}

.cfg-form {
  max-width: 640px;
  padding-top: 8px;
}

.cfg-hint {
  margin-left: 12px;
  font-size: 12px;
}

.cfg-alert {
  margin-top: 12px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chat-card {
  :deep(.el-card__body) {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
}

.msg-list {
  height: 480px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}

.msg-row {
  display: flex;

  &.user {
    justify-content: flex-end;
  }
}

.bubble {
  max-width: 82%;
  padding: 10px 14px;
  border-radius: var(--app-radius);
  line-height: 1.6;
  font-size: 13.5px;
  word-break: break-word;
}

.user-bubble {
  background: var(--el-color-primary);
  color: var(--el-color-white);
  white-space: pre-wrap;
}

.ai-bubble {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}

.note-bubble {
  margin: 0 auto;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-radius: var(--app-radius);
  padding: 4px 14px;
}

.cursor {
  color: var(--el-color-primary);
}

/* markdown 简易渲染 */
.md {
  :deep(.md-pre) {
    background: var(--el-fill-color-darker);
    border-radius: var(--app-radius);
    padding: 8px 10px;
    margin: 6px 0;
    overflow-x: auto;
    font-size: 12.5px;
    line-height: 1.5;
  }

  :deep(.md-inline) {
    background: var(--el-fill-color-darker);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 12.5px;
  }

  :deep(pre),
  :deep(code) {
    font-family: 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  }
}

/* 工具调用气泡 */
.tool-call {
  margin-top: 8px;
  border: 1px dashed var(--el-color-warning);
  border-radius: var(--app-radius);
  padding: 8px 10px;
  background: var(--el-color-warning-light-9);
}

.tc-head {
  display: flex;
  align-items: center;
  gap: 8px;

  .tc-name {
    font-weight: 600;
    font-size: 12.5px;
  }
}

.tc-block {
  margin-top: 6px;

  .tc-label {
    font-size: 12px;
  }

  .tc-pre {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--el-fill-color);
    border-radius: var(--app-radius);
    font-size: 12px;
    line-height: 1.5;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.input-bar {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.input-actions {
  display: flex;
  gap: 8px;
}

/* 工具侧栏 */
.tools-card {
  :deep(.el-card__body) {
    padding: 8px;
  }
}

.tool-list {
  max-height: 560px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tool-item {
  padding: 8px 10px;
  border-radius: var(--app-radius);
  cursor: pointer;
  border: 1px solid transparent;

  &:hover {
    background: var(--el-color-primary-light-9);
    border-color: var(--el-color-primary-light-5);
  }

  .tool-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--el-color-primary);
  }

  .tool-desc {
    font-size: 12px;
    line-height: 1.5;
    margin-top: 2px;
  }
}
</style>
