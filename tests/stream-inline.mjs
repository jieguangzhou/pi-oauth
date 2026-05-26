// Regression test: chatStream must yield meaningful chunks (text/tool/etc) inline,
// not buffer them until turnEnded. We stub chatStreamOnce with a generator that
// pauses between yields and assert the caller observes each chunk before the
// stub has produced the next one.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(join(root, 'tests/stream-inline.mjs'));
const { createJiti } = require(join(root, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'));
const jiti = createJiti(root);
const { AgentServiceClient, decideAlignment, guardPendingHttp2ConnectCancel, isPendingHttp2TlsCancel } = jiti(join(root, 'src/cursor-agent/agent-service.ts'));

const client = new AgentServiceClient('test-token', { baseUrl: 'https://example.invalid' });

// Keep Cursor retry/Resume budgets at their defaults; the stubbed chatStreamOnce
// generators in this file never produce errors that would actually consume more
// than one transport attempt unless explicitly asked.

// Each await on `releaseNext` returns once the consumer requests another chunk
// AFTER the previous one was yielded. By gating production on consumption we
// can detect any internal buffering: if chatStream were still buffering, the
// consumer would not iterate until the stub had produced everything.
function gatedStub(chunks) {
  let releaseNext;
  let nextResolved = new Promise((resolve) => { releaseNext = resolve; });

  async function* generator() {
    for (const chunk of chunks) {
      yield chunk;
      // Wait until the consumer signals "I observed the previous chunk" before
      // emitting the next one.
      await nextResolved;
      nextResolved = new Promise((resolve) => { releaseNext = resolve; });
    }
  }

  return { generator: generator(), release: () => releaseNext() };
}

const chunks = [
  { type: 'text', content: 'Hello, ' },
  { type: 'text', content: 'world' },
  { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
  { type: 'done' },
];

const stub = gatedStub(chunks);
client.chatStreamOnce = () => stub.generator;

const observed = [];
const stream = client.chatStream({ message: 'hi', model: 'composer-2.5' });

// Consume one chunk at a time and release the stub between iterations.
const iter = stream[Symbol.asyncIterator]();
for (;;) {
  const { value, done } = await iter.next();
  if (done) break;
  observed.push(value);
  if (observed.length >= chunks.length) break; // safety
  stub.release(); // allow stub to emit the next chunk
}

assert.equal(observed.length, chunks.length, `expected ${chunks.length} chunks streamed, got ${observed.length}`);
assert.equal(observed[0].type, 'text');
assert.equal(observed[0].content, 'Hello, ');
assert.equal(observed[1].type, 'text');
assert.equal(observed[1].content, 'world');
assert.equal(observed[2].type, 'usage');
assert.equal(observed[3].type, 'done');

// Test the tool-handoff path: chatStream must yield exec_request inline and
// then close so the caller can dispatch the tool call on the live bridge.
const toolStub = gatedStub([
  { type: 'text', content: 'reading file...' },
  { type: 'exec_request', execRequest: { type: 'read', id: 1, path: '/foo' } },
  // anything after exec_request must be ignored by chatStream
  { type: 'text', content: 'unreachable' },
]);
client.chatStreamOnce = () => toolStub.generator;

const toolObserved = [];
const toolStream = client.chatStream({ message: 'read file', model: 'composer-2.5' });
const toolIter = toolStream[Symbol.asyncIterator]();
for (;;) {
  const { value, done } = await toolIter.next();
  if (done) break;
  toolObserved.push(value);
  if (toolObserved.length >= 2) break;
  toolStub.release();
}

assert.equal(toolObserved.length, 2);
assert.equal(toolObserved[0].type, 'text');
assert.equal(toolObserved[0].content, 'reading file...');
assert.equal(toolObserved[1].type, 'exec_request');
// chatStream must return after exec_request — pulling once more yields done.
const done = await toolIter.next();
assert.equal(done.done, true, 'chatStream should close right after exec_request');

// Active Cursor tool runs are different: the background pump must keep the
// AgentService bridge open after yielding exec_request so the next pi turn can
// submit the tool result over the same live stream. If chatStream closes here,
// sendToolResult later fails with "No active chat stream" and pi falls back to
// replaying context, which makes Cursor repeat the same tool call/checkpoint.
{
  const activeClient = new AgentServiceClient('test-token', { baseUrl: 'https://example.invalid' });
  const activeStub = gatedStub([
    { type: 'exec_request', execRequest: { type: 'read', id: 2, path: '/bar' } },
    { type: 'text', content: 'continued after tool result' },
    { type: 'done' },
  ]);
  activeClient.chatStreamOnce = () => activeStub.generator;

  const activeObserved = [];
  const activeIter = activeClient
    .chatStream({ message: 'read file', model: 'composer-2.5', keepStreamOpenOnExecRequest: true })
    [Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await activeIter.next();
    if (done) break;
    activeObserved.push(value);
    if (activeObserved.length >= 3) break;
    activeStub.release();
  }

  assert.equal(activeObserved.length, 3);
  assert.equal(activeObserved[0].type, 'exec_request');
  assert.equal(activeObserved[1].type, 'text');
  assert.equal(activeObserved[1].content, 'continued after tool result');
  assert.equal(activeObserved[2].type, 'done');
}

// Unit checks on decideAlignment — the suffix-prefix overlap detector that
// chatStream uses to dedup Resume text against the unsafe checkpoint window.
// All decisions below pass force=true so we exercise the decision logic without
// the "wait for more bytes" branches.
{
  // No unsafe window → never dedup.
  assert.deepEqual(decideAlignment('', 'anything', true), { skip: 0 });
  // Continuation (pending starts fresh, no overlap with unsafe tail).
  assert.deepEqual(decideAlignment('ABCDEFGH', 'IJKL', true), { skip: 0 });
  // Full replay then continuation.
  assert.deepEqual(decideAlignment('ABCDEFGH', 'ABCDEFGHIJKL', true), { skip: 8 });
  // Partial replay (server kept the last 4 chars then continued).
  assert.deepEqual(decideAlignment('ABCDEFGH', 'EFGHIJKL', true), { skip: 4 });
  // Single-char overlap at the tail.
  assert.deepEqual(decideAlignment('ABCDEFGH', 'HIJKL', true), { skip: 1 });
  // Divergence with no shared suffix-prefix → yield as-is.
  assert.deepEqual(decideAlignment('ABCDEFGH', 'XYZ', true), { skip: 0 });
}
// Without force, decideAlignment should wait when pending could still grow
// into a full replay.
{
  // pending is a strict prefix of unsafe → wait for more.
  assert.equal(decideAlignment('ABCDEFGH', 'ABC', false), null);
  // pending fully covers unsafe → commit.
  assert.deepEqual(decideAlignment('ABCDEFGH', 'ABCDEFGH', false), { skip: 8 });
  // pending diverges short of any overlap → wait until we have 32 bytes to be sure.
  assert.equal(decideAlignment('ABCDEFGH', 'X', false), null);
  // pending is long enough to trust → commit even with k=0.
  assert.deepEqual(decideAlignment('ABCDEFGH', 'X'.repeat(64), false), { skip: 0 });
}

// chatStream Resume + alignment: simulate first attempt yielding "Hello, world."
// before erroring, then Resume re-emitting "world." with extra continuation.
// The consumer should see "Hello, world." followed by exactly the continuation,
// no duplicate "world.".
{
  const resumeClient = new AgentServiceClient('test-token', { baseUrl: 'https://example.invalid' });
  let attempt = 0;
  resumeClient.chatStreamOnce = async function* (request) {
    attempt++;
    if (attempt === 1) {
      yield { type: 'text', content: 'Hello, ' };
      yield { type: 'checkpoint', checkpoint: new Uint8Array([1, 2, 3]) };
      yield { type: 'text', content: 'world.' };
      yield { type: 'error', error: 'Stream ended without turnEnded — connection likely dropped mid-stream' };
      return;
    }
    // On resume the server emits a partial replay of the last 6 chars ("world.")
    // plus the actual continuation. Alignment must strip the replay so the
    // consumer ends up with exactly one copy.
    assert.equal(request.action, 'resume', 'resume attempt should use resume action');
    yield { type: 'text', content: 'world. How are you?' };
    yield { type: 'done' };
  };

  const ev = [];
  for await (const chunk of resumeClient.chatStream({ message: 'hi', model: 'composer-2.5' })) {
    ev.push(chunk);
  }
  const textParts = ev.filter((c) => c.type === 'text').map((c) => c.content);
  const merged = textParts.join('');
  assert.equal(merged, 'Hello, world. How are you?', `expected merged="Hello, world. How are you?" got=${JSON.stringify(merged)}`);
  assert.ok(ev.some((c) => c.type === 'checkpoint'), 'checkpoint chunks should pass through');
  assert.ok(ev.some((c) => c.type === 'done'), 'done chunk should reach the consumer');
}

// Edge case: error before any text yielded → keep existing retry/resume behavior,
// no alignment needed, no duplicate risk.
{
  const earlyErrClient = new AgentServiceClient('test-token', { baseUrl: 'https://example.invalid' });
  let attempt = 0;
  earlyErrClient.chatStreamOnce = async function* () {
    attempt++;
    if (attempt === 1) {
      yield { type: 'checkpoint', checkpoint: new Uint8Array([9]) };
      yield { type: 'error', error: 'fetch failed' };
      return;
    }
    yield { type: 'text', content: 'recovered' };
    yield { type: 'done' };
  };

  const ev = [];
  for await (const chunk of earlyErrClient.chatStream({ message: 'hi', model: 'composer-2.5' })) {
    ev.push(chunk);
  }
  const merged = ev.filter((c) => c.type === 'text').map((c) => c.content).join('');
  assert.equal(merged, 'recovered');
}

// isPendingHttp2TlsCancel: must match ONLY the exact Node http2 closeSession
// throw that fires when the TLS handshake fails on a pending stream. Any
// drift in this matcher would either let the host process crash or, worse,
// swallow unrelated http2 errors.
{
  const connectingClient = { connecting: true };
  const settledClient = { connecting: false };

  const tlsCause = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
  const realThrow = Object.assign(new Error('The pending stream has been canceled'), { code: 'ERR_HTTP2_STREAM_CANCEL' });
  assert.equal(isPendingHttp2TlsCancel(realThrow, tlsCause, connectingClient), true, 'should match the real TLS-handshake closeSession throw');

  assert.equal(isPendingHttp2TlsCancel(realThrow, tlsCause, settledClient), false, 'must not match after the session is connected');

  const wrongCode = Object.assign(new Error('something else'), { code: 'ERR_HTTP2_STREAM_ERROR' });
  assert.equal(isPendingHttp2TlsCancel(wrongCode, tlsCause, connectingClient), false, 'must not match other http2 errors');

  const wrongCause = Object.assign(new Error('The pending stream has been canceled'), { code: 'ERR_HTTP2_STREAM_CANCEL' });
  assert.equal(isPendingHttp2TlsCancel(wrongCause, new Error('user aborted'), connectingClient), false, 'must not match unrelated causes');

  assert.equal(isPendingHttp2TlsCancel(null, tlsCause, connectingClient), false);
  assert.equal(isPendingHttp2TlsCancel(undefined, tlsCause, connectingClient), false);
  assert.equal(isPendingHttp2TlsCancel('string', tlsCause, connectingClient), false);
}

// guardPendingHttp2ConnectCancel: must intercept ONLY the targeted throw on
// THIS session instance, restore the original destroy on cleanup, and never
// touch the prototype or any other instance.
{
  const tlsCause = Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });
  const throwingDestroy = function destroy() {
    throw Object.assign(new Error('The pending stream has been canceled'), { code: 'ERR_HTTP2_STREAM_CANCEL' });
  };

  // Target case: pending TLS-handshake throw is swallowed and surfaces via the guard promise.
  const trapped = { connecting: true, destroy: throwingDestroy };
  const guard = guardPendingHttp2ConnectCancel(trapped);
  assert.notEqual(trapped.destroy, throwingDestroy, 'destroy should be replaced after guarding');
  let surfaced;
  guard.promise.catch((err) => { surfaced = err; });
  // simulate socketOnError calling destroy(error) with the TLS cause
  const ret = trapped.destroy(tlsCause);
  assert.equal(ret, undefined, 'guarded destroy should swallow the throw and return undefined');
  await new Promise((r) => setImmediate(r));
  assert.equal(surfaced, tlsCause, 'guard promise should reject with the original TLS cause');
  guard.restore();
  assert.equal(trapped.destroy, throwingDestroy, 'restore should put the original destroy back');

  // Non-matching throw must be re-thrown unchanged.
  const otherThrow = Object.assign(new Error('boom'), { code: 'ERR_HTTP2_PROTOCOL_ERROR' });
  const otherDestroy = function destroy() { throw otherThrow; };
  const otherClient = { connecting: true, destroy: otherDestroy };
  const guard2 = guardPendingHttp2ConnectCancel(otherClient);
  assert.throws(() => otherClient.destroy(new Error('unrelated')), /boom/, 'unrelated throws must propagate');
  guard2.restore();
  assert.equal(otherClient.destroy, otherDestroy);

  // Non-throwing destroy is a no-op (the original return value passes through).
  const normalDestroy = function destroy() { return 'ok'; };
  const normalClient = { connecting: true, destroy: normalDestroy };
  const guard3 = guardPendingHttp2ConnectCancel(normalClient);
  assert.equal(normalClient.destroy(), 'ok', 'guarded destroy should pass through normal returns');
  guard3.restore();
  assert.equal(normalClient.destroy, normalDestroy);

  // Same-session-only: guarding one client must not affect another.
  const a = { connecting: true, destroy: throwingDestroy };
  const b = { connecting: true, destroy: throwingDestroy };
  const guardA = guardPendingHttp2ConnectCancel(a);
  assert.equal(a.destroy === throwingDestroy, false, 'A wrapped');
  assert.equal(b.destroy, throwingDestroy, 'B untouched');
  guardA.restore();
}

console.log('stream inline checks passed');
