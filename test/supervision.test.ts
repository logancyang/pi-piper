import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Runner, type JobEvent } from '../src/runner.js';
import { codingPrompt } from '../src/context.js';
import { statusInstruction, turnStatus } from '../src/supervision.js';

const exec = promisify(execFile);
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'piper-supervision-'));
  const legacy = join(dir, 'reported-event-ids.txt');
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const open = async () => {
    const storage = await openNodeSqliteStorage(join(dir, 'state.db'));
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, ctx);
    const runner: Runner = Reflect.construct(Runner, [harness, storage, models]);
    Object.assign(runner, { eventFile: join(dir, 'events.jsonl') });
    await runner.recover(); // The same startup/reconciliation path used by the daemon.
    return runner;
  };
  let runner = await open();
  return {
    dir, legacy, faux, get runner() { return runner; },
    async restart() { await runner.close(); runner = await open(); },
    async close() { await runner.close(); rmSync(dir, { recursive: true, force: true }); },
    async complete(key: string, message: string, cwd = process.cwd()) {
      faux.setResponses([fauxAssistantMessage(message)]);
      const job = await runner.start(key, cwd, 'faux/faux-1', 'high');
      const notification = once(runner.notifications, 'event', { signal: AbortSignal.timeout(10_000) });
      const input = await runner.submit(job, 'Offline fixture', key);
      await (await runner.harness.submission(input.submissionId, ctx))!.wait(ctx);
      const [event] = await notification;
      assert.equal(event.requestId, key);
      return event as JobEvent;
    },
  };
}

test('turn-end parsing fails safe for missing, malformed, non-final and empty status lines', () => {
  assert.deepEqual(turnStatus('Finished.\nSTATUS: DONE\n'), { type: 'done' });
  assert.deepEqual(turnStatus('STATUS: NEEDS_INPUT: Approve publishing?'), { type: 'needs_input', question: 'Approve publishing?' });
  assert.deepEqual(turnStatus('Details\nSTATUS: BLOCKED: Build credentials unavailable'), { type: 'blocked', reason: 'Build credentials unavailable' });
  for (const message of ['Summary without a status\nKeep the full last message.', 'STATUS: MAYBE',
    'STATUS: NEEDS_INPUT:', 'STATUS: BLOCKED:   ', 'STATUS: DONE\nMore text', 'STATUS: DONE extra', 'STATUS: NEEDS_INPUT: yes\nSTATUS: nope']) {
    assert.deepEqual(turnStatus(message), { type: 'needs_input', question: message });
  }
  assert.equal(turnStatus('').type, 'needs_input');
});

test('the coding system prompt includes the decision and final-status contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piper-prompt-'));
  try { assert.ok((await codingPrompt(dir)).includes(statusInstruction)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('watch covers all non-test jobs, repeats unacked events, and blocks again after durable ack', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.runner.watch(undefined, 0), { type: 'timeout' });
    const wake = f.runner.watch(undefined, 5);
    const first = await f.complete('one', 'Please approve.\nSTATUS: NEEDS_INPUT: May I publish?');
    assert.deepEqual(await wake, [first]);
    assert.deepEqual(await f.runner.watch(undefined, 0), [first], 'watch does not acknowledge delivery');
    const second = await f.complete('two', 'STATUS: BLOCKED: Missing approval');
    const third = await f.complete('three', 'STATUS: DONE', '/tmp-not-a-test');
    assert.deepEqual(await f.runner.pending(), [first, second, third]);
    assert.deepEqual(await f.runner.watch(first.id, 0), [second, third]);
    for (const cursor of ['unknown-cursor', 'toString']) await assert.rejects(f.runner.watch(cursor, 0), /Invalid event cursor/);
    await f.runner.ack([first.id, second.id, third.id]);
    await f.runner.ack([first.id]); // Idempotent, including across restart.
    assert.deepEqual(await f.runner.pending(), []);
    assert.deepEqual(await f.runner.watch(first.id, 0.02), { type: 'timeout' });
    // An event can arrive during watch acquisition: there is no read/subscribe gap.
    const nextWake = f.runner.watch(undefined, 5);
    await f.complete('temporary', 'STATUS: DONE', f.dir);
    assert.deepEqual(await f.runner.pending(), [], 'cwd under /tmp is skipped, not acknowledged');
    const missing = 'Work ended without the contract.\nThis entire message needs attention.';
    const fourth = await f.complete('four', missing);
    assert.deepEqual(await nextWake, [fourth]);
    assert.equal(fourth.type, 'needs_input'); assert.equal(fourth.question, missing);
    assert.ok(fourth.sequence! > third.sequence!);
  } finally { await f.close(); }
});

test('settled wait ignores an earlier submission while a follow-up is queued', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const job = await f.runner.start('wait-follow-up', process.cwd(), 'faux/faux-1', 'high');
    let releaseFollowUp!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    let followUpStarted!: () => void;
    const runningFollowUp = new Promise<void>(resolve => { followUpStarted = resolve; });
    f.faux.setResponses([fauxAssistantMessage('STATUS: DONE'), (_context, options) => new Promise(resolve => {
      releaseFollowUp = resolve;
      followUpStarted();
      options!.signal!.addEventListener('abort', () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' })), { once: true });
    })]);
    const firstEvent = new Promise<JobEvent>(resolve => {
      const observe = (event: JobEvent) => {
        if (event.job === job.key && event.type !== 'pr_opened') { f.runner.notifications.off('event', observe); resolve(event); }
      };
      f.runner.notifications.on('event', observe);
    });
    const first = await f.runner.submit(job, 'First', 'first');
    let resolveWait!: (event: JobEvent) => void;
    const waited = new Promise<JobEvent>(resolve => { resolveWait = resolve; });
    const listener = async (event: JobEvent) => {
      if (event.job === job.key && await f.runner.isCurrentSettled(job, event)) {
        f.runner.notifications.off('event', listener);
        resolveWait(event);
      }
    };
    f.runner.notifications.on('event', listener);
    const second = await f.runner.submit(job, 'Follow-up', 'second');
    await runningFollowUp;
    await (await f.runner.harness.submission(first.submissionId, ctx))!.wait(ctx);
    assert.equal((await firstEvent).submissionId, first.submissionId);
    let resolved = false;
    void waited.then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(resolved, false, 'first submission cannot settle the job while its follow-up is running');
    releaseFollowUp(fauxAssistantMessage('STATUS: BLOCKED: Follow-up'));
    await (await f.runner.harness.submission(second.submissionId, ctx))!.wait(ctx);
    const event = await waited;
    assert.equal(event.submissionId, second.submissionId);
    assert.equal(event.type, 'blocked');
  } finally { await f.close(); }
});

test('settlement uses each submission answer, not the latest message in a busy conversation', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const job = await f.runner.start('queued', process.cwd(), 'faux/faux-1', 'high');
    f.faux.setResponses([fauxAssistantMessage('STATUS: NEEDS_INPUT: Which scope?'), fauxAssistantMessage('STATUS: DONE')]);
    const first = await f.runner.submit(job, 'First', 'first');
    const second = await f.runner.submit(job, 'Second', 'second');
    await (await f.runner.harness.submission(second.submissionId, ctx))!.wait(ctx);
    // Stop and reopen to exercise recovery against a transcript containing both answers.
    await f.restart();
    const events = await f.runner.pending();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => [e.submissionId, e.type, e.question]), [
      [first.submissionId, 'needs_input', 'Which scope?'], [second.submissionId, 'done', undefined],
    ]);
  } finally { await f.close(); }
});

test('SQLite restart preserves unacked events, acknowledgements, and repairs a missing outbox receipt exactly once', { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.complete('acked', 'STATUS: DONE');
    const second = await f.complete('unacked', 'STATUS: BLOCKED: Offline blocker');
    await f.runner.ack([first.id]);
    // Simulate a crash after the submission settled but before its outbox commit.
    const outbox = defineDoc<any>({ kind: 'piper.events', version: 1, scope: 'session', initial: () => ({ events: {} }) });
    await f.runner.harness.commit(async tx => { delete (await tx.doc(outbox)).events[second.id]; }, ctx);
    const calls = f.faux.state.callCount;
    await f.restart();
    const [recovered] = await f.runner.pending();
    assert.equal(recovered.id, second.id); assert.equal(recovered.type, 'blocked');
    assert.equal(recovered.reason, 'Offline blocker');
    assert.deepEqual(await f.runner.watch(undefined, 0), [recovered]);
    await f.restart();
    assert.deepEqual(await f.runner.watch(undefined, 0), [recovered]);
    await f.runner.ack([second.id]);
    await f.restart();
    assert.deepEqual(await f.runner.pending(), []);
    assert.deepEqual(await f.runner.watch(undefined, 0.02), { type: 'timeout' });
    assert.equal(f.faux.state.callCount, calls, 'daemon recovery does not invoke a model for settled turns');
  } finally { await f.close(); }
});

test('supervisor CLI prints JSON lines, acknowledges multiple IDs, lists pending, and exits 2 on timeout (offline socket)', { timeout: 60_000 }, async () => {
  const f = await fixture();
  mkdirSync(join(f.dir, '.pi-piper'));
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const c = JSON.parse(body);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const result = c.op === 'watch' ? await f.runner.watch(c.since, c.timeout, controller.signal)
      : c.op === 'ack' ? await f.runner.ack(c.ids) : await f.runner.pending();
    res.end(JSON.stringify(result));
  });
  const cli = async (args: string[], code = 0) => {
    const result = await exec(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname,
      new URL('../src/main.ts', import.meta.url).pathname, ...args], { env: { ...process.env, HOME: f.dir }, timeout: 20_000 }).catch(error => {
      assert.equal(error.code, code, error.stderr); return error;
    });
    assert.equal(result.code ?? 0, code, result.stderr);
    return result.stdout.trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line));
  };
  try {
    await new Promise<void>(resolve => server.listen(join(f.dir, '.pi-piper/daemon.sock'), resolve));
    const a = await f.complete('cli-one', 'STATUS: DONE');
    const b = await f.complete('cli-two', 'STATUS: NEEDS_INPUT: Approval?');
    assert.deepEqual(await cli(['pending']), [a, b]);
    assert.deepEqual(await cli(['watch', '--timeout', '0']), [a, b]);
    assert.deepEqual(await cli(['watch', '--since', a.id, '--timeout', '0']), [b]);
    assert.deepEqual(await cli(['ack', a.id, b.id]), [{ acked: [a.id, b.id] }]);
    assert.deepEqual(await cli(['pending']), []);
    assert.deepEqual(await cli(['watch', '--timeout', '0.01'], 2), [{ type: 'timeout' }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await f.close();
  }
});
