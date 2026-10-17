import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Runner } from '../src/runner.js';

const exec = promisify(execFile);
test('cancel CLI aborts the active turn, drops queued inputs and survives SQLite reopen without restarting work', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'piper-cancel-'));
  mkdirSync(join(dir, '.pi-piper'));
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  faux.setResponses([(_context, options) => new Promise(resolve => {
    options!.signal!.addEventListener('abort', () => resolve(fauxAssistantMessage('', { stopReason: 'aborted' })), { once: true });
    started();
  })]);
  const open = async () => {
    const storage = await openNodeSqliteStorage(join(dir, 'state.db'));
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, ctx);
    // Exercise Runner methods with a real Harness/storage and a local faux provider, not ModelRuntime/login.
    const runner: Runner = Reflect.construct(Runner, [harness, storage, models]);
    Object.assign(runner, { eventFile: join(dir, 'events.jsonl') });
    return runner;
  };
  let runner = await open();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const command = JSON.parse(body);
    assert.deepEqual(command, { op: 'cancel', job: 'cancel-job' });
    res.end(JSON.stringify(await runner.cancel(await runner.job(command.job))));
  });
  try {
    const job = await runner.start('cancel-job', dir, 'faux/faux-1', 'high');
    const active = await runner.submit(job, 'Hold until cancelled', 'active');
    await running;
    const queued = await runner.submit(job, 'Must never run', 'queued');
    assert.equal(queued.status, 'queued');
    const socket = join(dir, '.pi-piper/daemon.sock');
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const cli = new URL('../src/main.ts', import.meta.url).pathname;
    const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
    const result = await exec(process.execPath, ['--import', loader, cli, 'cancel', job.key], { env: { ...process.env, HOME: dir } });
    assert.deepEqual(JSON.parse(result.stdout), { job: job.key, status: 'cancelled' });
    for (const id of [active.submissionId, queued.submissionId]) {
      const receipt = await (await runner.harness.submission(id, ctx))!.wait(ctx);
      assert.equal(receipt.status, 'unanswered'); assert.equal(receipt.reason, 'aborted');
    }
    assert.equal((await runner.status(job)).queued, 0);
    const calls = faux.state.callCount;
    await runner.close();
    runner = await open();
    const recovered = await runner.start(job.key, dir, 'faux/faux-1', 'high');
    runner.harness.resume();
    await (await runner.harness.conversation(recovered.conversationId, ctx))!.waitForIdle(ctx);
    const inspection = await runner.harness.inspect(ctx);
    assert.equal(inspection.tasks.length, 0); assert.equal(inspection.submissions.length, 0);
    const retry = await runner.submit(recovered, 'Must never run', 'queued');
    assert.equal(retry.submissionId, queued.submissionId); assert.equal(retry.status, 'unanswered');
    assert.equal(faux.state.callCount, calls, 'recovery and admission retry cannot restart cancelled work');
    assert.equal((await runner.status(recovered)).status, 'idle');
    await runner.cancel(recovered); // Cancelling an idle job is harmless.
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
