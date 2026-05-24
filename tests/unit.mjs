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
assert.match(cursorSource, /registerCommand\("cursor"/, 'Cursor guidance command should be registered');
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
assert.match(cursorSource, /official Cursor CLI\/API-key paths/, 'Cursor module should prefer official auth paths');
assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{12,}/, 'source should not contain API keys');

console.log('unit checks passed');
