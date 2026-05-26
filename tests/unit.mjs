import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entrySource = readFileSync(join(root, 'src/index.ts'), 'utf8');
const xaiSource = readFileSync(join(root, 'src/xai.ts'), 'utf8');
const cursorSource = readFileSync(join(root, 'src/cursor.ts'), 'utf8');
const source = `${entrySource}\n${xaiSource}\n${cursorSource}`;

assert.equal(pkg.name, 'pi-oauth');
assert.ok(pkg.keywords.includes('pi-package'), 'package should be discoverable as a pi package');
assert.deepEqual(pkg.pi?.extensions, ['./src/index.ts'], 'pi manifest should load src/index.ts');
assert.ok(existsSync(join(root, 'src/index.ts')), 'extension entry exists');
assert.ok(existsSync(join(root, 'src/xai.ts')), 'xAI module exists');
assert.ok(existsSync(join(root, 'src/cursor.ts')), 'Cursor module exists');
assert.ok(existsSync(join(root, 'README.md')), 'README exists');
assert.ok(existsSync(join(root, 'LICENSE')), 'LICENSE exists');
assert.ok(existsSync(join(root, 'CHANGELOG.md')), 'CHANGELOG exists');

for (const dep of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) {
  assert.equal(pkg.peerDependencies?.[dep], '*', `peer dependency ${dep} should be declared`);
}

for (const model of ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1', 'grok-code-fast-1']) {
  assert.match(xaiSource, new RegExp(`id:\\s*["']${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`), `model ${model} should be registered`);
}

assert.match(entrySource, /registerXai\(pi\)/, 'entry should register xAI module');
assert.match(entrySource, /registerCursor\(pi\)/, 'entry should register Cursor module');
assert.match(xaiSource, /const PROVIDER_ID = "xai-grok"/, 'provider id should be stable');
assert.match(xaiSource, /name: "search_x_posts"/, 'X search tool should use clear, explicit name');
assert.match(xaiSource, /type: "x_search"/, 'X search tool should call xAI x_search');
assert.match(xaiSource, /name: "generate_xai_image"/, 'image generation tool should use clear, explicit name');
assert.match(xaiSource, /\/images\/generations/, 'image generation tool should call xAI image generation');
assert.match(entrySource, /registerCommand\("oauth"/, 'pi-oauth management command should be registered');
assert.match(xaiSource, /registerCommand\("xai"/, 'xAI management command should be registered');
assert.match(cursorSource, /registerCommand\("cursor"/, 'Cursor management command should be registered');
assert.match(cursorSource, /registerProvider\(PROVIDER_ID/, 'Cursor provider should be registered');
assert.match(cursorSource, /loginDeepControl/, 'Cursor provider should use browser OAuth authorization');
assert.match(cursorSource, /streamSimple:\s*streamCursorDirect/, 'Cursor provider should stream through the direct subscription AgentService path');
assert.match(cursorSource, /GetUsableModels|discoverCursorModels|cursorModels/, 'Cursor provider should discover subscription model availability');
const cursorAgentServiceSource = readFileSync(join(root, 'src/cursor-agent/agent-service.ts'), 'utf8');
assert.match(cursorAgentServiceSource, /application\/proto/, 'Cursor model discovery should use native HTTP\/2 unary protobuf transport');
assert.match(cursorAgentServiceSource, /\/agent\.v1\.AgentService\/Run/, 'Cursor streaming should use native Cursor CLI HTTP\/2 AgentService Run when available');
assert.match(cursorAgentServiceSource, /application\/connect\+proto/, 'Cursor streaming should use Cursor CLI-compatible Connect streaming transport');
assert.match(cursorAgentServiceSource, /connect-protocol-version/, 'Cursor AgentService requests should include Connect protocol version like Cursor CLI');
assert.match(cursorAgentServiceSource, /encodeRequestedModel/, 'Cursor AgentService requests should include Cursor RequestedModel metadata');
assert.match(cursorAgentServiceSource, /buildRequestContext\([^\n]+request\.systemPrompt/, 'Cursor AgentService requests should carry pi system prompt as RequestContext rules');
assert.match(cursorAgentServiceSource, /action: "resume"/, 'Cursor AgentService should retry dropped streams with resumeAction instead of prompt replay');
assert.match(cursorAgentServiceSource, /Stream ended without turnEnded/, 'Cursor AgentService should treat missing turnEnded as a dropped stream');
assert.match(cursorAgentServiceSource, /request\.signal\?\.addEventListener\("abort"/, 'Cursor AgentService should wire pi abort signals into the transport');
assert.doesNotMatch(cursorAgentServiceSource, /x-cursor-checksum/, 'Cursor AgentService requests should not send legacy non-CLI checksum headers');
assert.match(cursorSource, /modifyModels/, 'Cursor OAuth credentials should be able to expose discovered models');
assert.match(cursorSource, /cursorModelSupportsThinking/, 'Cursor discovered models should preserve pi thinking-level selection support');
assert.match(readFileSync(join(root, 'src/cursor-agent/proto/agent-messages.ts'), 'utf8'), /encodeCursorRule/, 'Cursor system prompt should be encoded as native Cursor rules');
assert.match(cursorSource, /authStorage\.set\(PROVIDER_ID/, 'Cursor refresh-models should persist discovered subscription models');
assert.match(cursorSource, /PI_CURSOR_CONVERSATION_CACHE[^\n]+!== "0"/, 'Cursor conversation checkpoint cache should be enabled by default with an opt-out');
assert.match(cursorSource, /exec_request/, 'Cursor provider should translate Cursor AgentService tool requests into pi tool calls');
assert.match(cursorSource, /PI_CURSOR_ACTIVE_TOOLS/, 'Cursor same-bridge tool continuation should be guarded behind an explicit experimental flag');
assert.match(cursorSource, /keepStreamOpenOnExecRequest:\s*true/, 'Cursor active tool runs should keep the AgentService bridge open across pi tool execution');
assert.match(cursorAgentServiceSource, /keepStreamOpenOnExecRequest/, 'Cursor AgentService should support keeping streams open after exec_request handoff');
assert.match(cursorSource, /hasVisibleAssistantOutput/, 'Cursor late stream fallback must not replay after visible assistant output');
assert.match(cursorSource, /already-streamed answer as complete/, 'Cursor active run should finalize already-streamed text on late bridge errors');
assert.doesNotMatch(cursorSource, /from ["']@cursor\/sdk["']/, 'Cursor subscription provider should not require Cursor API-key SDK auth');
assert.doesNotMatch(cursorSource, /createServer/, 'Cursor provider should not start a localhost proxy');
assert.doesNotMatch(source, /registerCommand\("xai-tools"/, 'tool controls should live under the single /xai command');
assert.doesNotMatch(source, /registerCommand\("xai-quota"/, 'quota controls should live under the single /xai command');
assert.match(xaiSource, /https:\/\/grok\.com\/\?_s=usage/, 'xAI command should show the Grok usage URL');
assert.doesNotMatch(source, /x-ratelimit-remaining-requests/, 'xAI quota status should not expose unreliable API rate-limit probes');
assert.match(xaiSource, /DEFAULT_XAI_CONFIG/, 'xAI should define explicit install defaults');
assert.match(xaiSource, /search_x_posts:\s*false/, 'X search should default off on fresh install');
assert.match(xaiSource, /generate_xai_image:\s*false/, 'image generation should default off on fresh install');
assert.match(xaiSource, /ensureXaiConfigFile/, 'xAI should materialize default config on session start');
assert.match(xaiSource, /getAgentDir\(\), "extensions", "pi-oauth", "xai\.json"/, 'xAI config should live under the pi agent extension data directory');
assert.match(xaiSource, /writeXaiConfig/, 'xAI tool choices should be persisted');
assert.match(xaiSource, /formatBooleanMenuRow/, 'xAI management menu should show compact true/false rows');
assert.match(cursorSource, /auth\/poll/, 'Cursor module should poll Cursor OAuth completion');
assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{12,}/, 'source should not contain API keys');
assert.doesNotMatch(cursorAgentServiceSource, /const buffered: AgentStreamChunkType\[\]/, 'Cursor AgentService chatStream should yield chunks inline instead of buffering until turnEnded');

console.log('unit checks passed');
