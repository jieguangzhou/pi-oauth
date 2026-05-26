import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(join(root, 'tests/live-cursor-session.mjs'));
const { createJiti } = require(join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'));
const jiti = createJiti(root);
const { registerCursor } = jiti(join(root, 'src/cursor.ts'));

let provider;
registerCursor({
  registerProvider(id, config) { if (id === 'cursor') provider = config; },
  registerCommand() {},
});
assert.ok(provider, 'Cursor provider should register');

const authPath = join(process.env.HOME, '.pi/agent/auth.json');
const auth = JSON.parse(readFileSync(authPath, 'utf8'));
assert.ok(auth.cursor?.access, 'No Cursor OAuth credential found. Run /login → Cursor first.');

const modelId = process.env.CURSOR_LIVE_MODEL || 'composer-2.5';
const baseModel = provider.models.find((m) => m.id === modelId) || provider.models.find((m) => m.id === 'composer-2.5') || provider.models[0];
const model = { ...baseModel, provider: 'cursor', baseUrl: provider.baseUrl };
const turns = Number(process.env.CURSOR_LIVE_TURNS || 20);
const cacheEnabled = process.env.PI_CURSOR_CONVERSATION_CACHE !== '0';
const activeTools = process.env.PI_CURSOR_ACTIVE_TOOLS !== '0';
const textEncoder = new TextEncoder();
const bashTool = {
  name: 'bash',
  description: 'Run a bash command in the current workspace.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

function blockToText(block) {
  if (!block) return '';
  if (block.type === 'text') return block.text || '';
  if (block.type === 'toolCall') return `TOOL_CALL ${block.name}: ${JSON.stringify(block.arguments ?? {})}`;
  return '';
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockToText).filter(Boolean).join('\n');
  return JSON.stringify(content ?? '');
}

function buildPrompt(context) {
  const onlyMessage = context.messages.length === 1 ? context.messages[0] : undefined;
  if (onlyMessage?.role === 'user') return messageContentToText(onlyMessage.content);

  const lines = [];
  for (const message of context.messages) {
    if (message.role === 'user') lines.push(`USER: ${messageContentToText(message.content)}`);
    else if (message.role === 'assistant') lines.push(`ASSISTANT: ${message.content.map(blockToText).filter(Boolean).join('\n')}`);
    else lines.push(`TOOL RESULT (${message.toolName}${message.isError ? ', error' : ''}): ${message.content.map(blockToText).filter(Boolean).join('\n')}`);
  }
  if (context.messages.at(-1)?.role === 'toolResult') {
    lines.push("INSTRUCTION: The latest tool result is available above. Use it to answer the user's original request now; do not call another tool unless the result is missing or unusable.");
  }
  return lines.join('\n\n');
}

function byteLength(text) { return textEncoder.encode(text).length; }

function assistantMsg(content, stopReason = 'stop') {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: 'cursor',
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  return { count: values.length, p50: percentile(values, 50), p90: percentile(values, 90), p95: percentile(values, 95), min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}

async function callCursor(context) {
  const fullPromptBytes = byteLength(buildPrompt(context));
  const last = context.messages.at(-1);
  const activeToolResume = activeTools && last?.role === 'toolResult';
  const cacheEligible = cacheEnabled && ((last?.role === 'user' && context.messages.length > 1) || activeToolResume);
  const estimatedSentPromptBytes = cacheEligible ? byteLength(messageContentToText(last.content)) : fullPromptBytes;
  const started = Date.now();
  let firstTextMs = null;
  let firstToolMs = null;
  let text = '';
  let toolCall;
  let error;
  let usage;
  const eventTypes = [];
  const stream = provider.streamSimple(model, context, { apiKey: auth.cursor.access, signal: AbortSignal.timeout(Number(process.env.CURSOR_LIVE_TIMEOUT_MS || 120_000)) });
  for await (const event of stream) {
    eventTypes.push(event.type === 'done' ? `done:${event.reason}` : event.type);
    if (event.type === 'text_delta') {
      firstTextMs ??= Date.now() - started;
      text += event.delta;
    } else if (event.type === 'toolcall_end') {
      firstToolMs ??= Date.now() - started;
      toolCall = event.toolCall;
    } else if (event.type === 'done') {
      usage = event.message?.usage;
    } else if (event.type === 'error') {
      error = event.error?.errorMessage || 'unknown error';
    }
  }
  const totalMs = Date.now() - started;
  return {
    text,
    toolCall,
    error,
    firstTextMs,
    firstToolMs,
    totalMs,
    eventTypes,
    usage,
    prompt: {
      cacheEligible,
      activeToolResume,
      fullPromptBytes,
      estimatedSentPromptBytes,
      estimatedReuseRatio: fullPromptBytes > 0 ? Math.max(0, 1 - estimatedSentPromptBytes / fullPromptBytes) : 0,
    },
  };
}

if (process.env.CURSOR_LIVE_SYSTEM_CHECK !== '0') {
  const expected = 'BANANA_SYSTEM_OK';
  const systemCheck = await callCursor({
    systemPrompt: `You are participating in a live Cursor Rules check. The required check phrase is ${expected}. When asked for the check phrase, answer exactly that phrase and nothing else.`,
    messages: [{ role: 'user', content: 'What is the live Cursor Rules check phrase?', timestamp: Date.now() }],
  });
  const ok = !systemCheck.error && systemCheck.text.trim().includes(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} systemPrompt answer=${JSON.stringify(systemCheck.text.trim())} first=${systemCheck.firstTextMs} total=${systemCheck.totalMs}`);
  if (!ok) {
    console.error(JSON.stringify(systemCheck, null, 2));
    process.exit(1);
  }
}

const systemPrompt = 'You are a coding agent. Use bash when the user asks to run a command. Answer the user\'s requested format exactly and concisely.';
const messages = [];
const results = [];
let failures = 0;

for (let i = 1; i <= turns; i++) {
  const user = { role: 'user', content: `第 ${i} 轮：请用 bash 执行 printf '${i}'，然后只回答工具输出的数字。`, timestamp: Date.now() };
  messages.push(user);

  const toolPhase = await callCursor({ systemPrompt, messages, tools: [bashTool] });
  if (!toolPhase.toolCall) {
    failures++;
    results.push({ turn: i, ok: false, phase: 'tool', toolPhase });
    break;
  }
  messages.push(assistantMsg([toolPhase.toolCall], 'toolUse'));

  let stdout = '';
  let toolError = '';
  try {
    stdout = execSync(toolPhase.toolCall.arguments.command, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    toolError = error instanceof Error ? error.message : String(error);
  }
  messages.push({ role: 'toolResult', toolCallId: toolPhase.toolCall.id, toolName: toolPhase.toolCall.name, content: [{ type: 'text', text: stdout || toolError }], isError: Boolean(toolError), timestamp: Date.now() });

  const answerPhase = await callCursor({ systemPrompt, messages, tools: [bashTool] });
  const ok = !answerPhase.error && answerPhase.text.trim().includes(String(i));
  if (!ok) failures++;
  messages.push(assistantMsg([{ type: 'text', text: answerPhase.text }], 'stop'));

  const result = {
    turn: i,
    ok,
    command: toolPhase.toolCall.arguments.command,
    stdout: stdout.trim(),
    answer: answerPhase.text.trim(),
    tool: toolPhase,
    answerPhase,
  };
  results.push(result);
  console.log(`${ok ? 'PASS' : 'FAIL'} turn=${i} toolMs=${toolPhase.firstToolMs ?? toolPhase.totalMs} answerFirst=${answerPhase.firstTextMs} answerTotal=${answerPhase.totalMs} reuse=${answerPhase.prompt.estimatedReuseRatio.toFixed(3)} cacheRead=${(toolPhase.usage?.cacheRead ?? 0) + (answerPhase.usage?.cacheRead ?? 0)}`);
  if (!ok && process.env.CURSOR_LIVE_STOP_ON_FAIL !== '0') break;
}

const answerFirst = results.map((r) => r.answerPhase?.firstTextMs).filter((v) => typeof v === 'number');
const answerTotal = results.map((r) => r.answerPhase?.totalMs).filter((v) => typeof v === 'number');
const toolLatency = results.map((r) => r.tool?.firstToolMs ?? r.tool?.totalMs).filter((v) => typeof v === 'number');
const fullPromptBytes = results.reduce((sum, r) => sum + (r.tool?.prompt.fullPromptBytes ?? 0) + (r.answerPhase?.prompt.fullPromptBytes ?? 0), 0);
const estimatedSentPromptBytes = results.reduce((sum, r) => sum + (r.tool?.prompt.estimatedSentPromptBytes ?? 0) + (r.answerPhase?.prompt.estimatedSentPromptBytes ?? 0), 0);
const usageTotals = results.reduce((acc, r) => {
  for (const phase of [r.tool, r.answerPhase]) {
    acc.input += phase?.usage?.input ?? 0;
    acc.output += phase?.usage?.output ?? 0;
    acc.cacheRead += phase?.usage?.cacheRead ?? 0;
    acc.cacheWrite += phase?.usage?.cacheWrite ?? 0;
    acc.totalTokens += phase?.usage?.totalTokens ?? 0;
  }
  return acc;
}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
const summary = {
  generatedAt: new Date().toISOString(),
  provider: 'cursor',
  model: model.id,
  cacheEnabled,
  activeTools,
  turnsRequested: turns,
  turnsCompleted: results.length,
  passed: results.filter((r) => r.ok).length,
  failures,
  firstTextMs: summarize(answerFirst),
  answerTotalMs: summarize(answerTotal),
  toolCallMs: summarize(toolLatency),
  promptReuse: {
    fullPromptBytes,
    estimatedSentPromptBytes,
    estimatedReuseRatio: fullPromptBytes > 0 ? Math.max(0, 1 - estimatedSentPromptBytes / fullPromptBytes) : 0,
    note: 'Estimated avoided prompt replay bytes from checkpoint reuse. See usageTotals for Cursor AgentService TurnEndedUpdate token counters when the backend provides them.',
  },
  usageTotals,
  results,
};

mkdirSync(join(root, 'test-results'), { recursive: true });
const out = join(root, 'test-results', 'live-cursor-session.json');
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`wrote ${out}`);
console.log(JSON.stringify({ passed: summary.passed, turns: summary.turnsCompleted, firstTextMs: summary.firstTextMs, toolCallMs: summary.toolCallMs, promptReuse: summary.promptReuse, usageTotals: summary.usageTotals }, null, 2));
if (failures > 0) process.exit(1);
