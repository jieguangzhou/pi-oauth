import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const agentDir = await mkdtemp(join(tmpdir(), 'pi-oauth-agent-'));
try {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    'xai-grok': {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 60 * 60 * 1000,
    },
  }, null, 2));

  const run = spawnSync('npx', [
    'pi',
    '--no-extensions',
    '-e', root,
    '--list-models',
    'xai-grok',
  ], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  assert.equal(run.status, 0, `pi package load failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const output = `${run.stdout}\n${run.stderr}`;
  for (const id of [
    'grok-4.3',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-build-0.1',
    'grok-code-fast-1',
  ]) {
    assert.match(output, new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), `model ${id} should be listed`);
  }

  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./src/index.ts']);
  console.log('package install smoke passed');
} finally {
  await rm(agentDir, { recursive: true, force: true });
}
