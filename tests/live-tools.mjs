import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const resultsDir = join(root, 'test-results');
mkdirSync(resultsDir, { recursive: true });
const results = [];

function runPi(args, timeout = 180_000) {
  const started = Date.now();
  const run = spawnSync('npx', ['pi', '--no-extensions', '-e', './src/index.ts', '--xai-tools', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: run.status,
    stdout: run.stdout || '',
    stderr: run.stderr || '',
    durationMs: Date.now() - started,
  };
}

const xSearch = runPi([
  '--model', 'xai-grok/grok-4.3',
  '--no-session',
  '--tools', 'search_x_posts',
  '--print',
  'Use search_x_posts to search X for recent public posts mentioning Grok 4.3. Reply in one concise sentence with a handle if available.',
]);
results.push({
  tool: 'search_x_posts',
  ok: xSearch.status === 0 && /Grok|xAI|@/.test(xSearch.stdout),
  status: xSearch.status,
  durationMs: xSearch.durationMs,
  stdoutPreview: xSearch.stdout.replace(/\s+/g, ' ').trim().slice(0, 500),
  stderrPreview: xSearch.stderr.replace(/\s+/g, ' ').trim().slice(0, 1000),
});

const imagePath = join(resultsDir, 'live-generated-image.jpg');
const image = runPi([
  '--model', 'xai-grok/grok-4.3',
  '--no-session',
  '--tools', 'generate_xai_image',
  '--print',
  `Use generate_xai_image with prompt exactly "a minimalist blue circle centered on a white background" and path exactly "${imagePath}". After the tool returns, reply with only the saved path.`,
], 240_000);
const imageExists = existsSync(imagePath);
const imageBytes = imageExists ? statSync(imagePath).size : 0;
results.push({
  tool: 'generate_xai_image',
  ok: image.status === 0 && imageExists && imageBytes > 1000,
  status: image.status,
  durationMs: image.durationMs,
  imagePath,
  imageBytes,
  stdoutPreview: image.stdout.replace(/\s+/g, ' ').trim().slice(0, 500),
  stderrPreview: image.stderr.replace(/\s+/g, ' ').trim().slice(0, 1000),
});

const out = join(resultsDir, 'live-tools.json');
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.tool} (${result.durationMs}ms)`);
  if (!result.ok) console.log(JSON.stringify(result, null, 2));
}
console.log(`wrote ${out}`);
assert.ok(results.every((result) => result.ok), 'one or more live tool tests failed');
