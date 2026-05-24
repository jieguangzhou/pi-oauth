import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const provider = 'xai-grok';
const models = [
  { id: 'grok-4.3', reasoning: true },
  { id: 'grok-4.20-0309-reasoning', reasoning: true },
  { id: 'grok-4.20-0309-non-reasoning', reasoning: false },
  { id: 'grok-build-0.1', reasoning: false },
];
const allThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const nonReasoningLevels = ['off'];
const results = [];
let failures = 0;

mkdirSync(join(root, 'test-results'), { recursive: true });

for (const model of models) {
  const levels = model.reasoning ? allThinkingLevels : nonReasoningLevels;
  for (const thinking of levels) {
    const prompt = `Live smoke test. Reply exactly: pi-oauth-ok-${model.id}-${thinking}`;
    const started = Date.now();
    const run = spawnSync('npx', [
      'pi', '--no-extensions', '-e', './src/index.ts',
      '--model', `${provider}/${model.id}`,
      '--thinking', thinking,
      '--no-session', '--no-tools', '--print', prompt,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: Number(process.env.PI_XAI_LIVE_TIMEOUT_MS || 180_000),
      maxBuffer: 1024 * 1024,
    });
    const stdout = (run.stdout || '').trim();
    const expected = `pi-oauth-ok-${model.id}-${thinking}`;
    const ok = run.status === 0 && stdout.includes(expected);
    if (!ok) failures += 1;
    const entry = {
      model: model.id,
      thinking,
      ok,
      status: run.status,
      durationMs: Date.now() - started,
      stdoutPreview: stdout.replace(/\s+/g, ' ').slice(0, 500),
      stderrPreview: (run.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 1000),
    };
    results.push(entry);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${model.id} thinking=${thinking} (${entry.durationMs}ms)`);
    if (!ok) console.log(JSON.stringify(entry, null, 2));
  }
}

const out = join(root, 'test-results', 'live-model-matrix.json');
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`wrote ${out}`);
if (failures > 0) process.exit(1);
