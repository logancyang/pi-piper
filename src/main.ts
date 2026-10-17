#!/usr/bin/env node
import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { Runner, home, hash, type JobEvent } from './runner.js';
import { runLoop } from './loop.js';
import { launchLoop, waitLoop } from './loop-io.js';
import { loadLoopOptions } from './loop-config.js';
import { cliArgs } from './self.js';

const socket = join(home, 'daemon.sock');
const pidFile = join(home, 'daemon.pid');
const logFile = join(home, 'daemon.log');
const nodeDir = dirname(process.execPath);
const help = `pi-piper daemon start|stop|status
pi-piper start <job> --cwd DIR (--prompt-file F | --prompt TEXT) [--model openai/gpt-4.1] [--thinking high] [--request-id ID]
pi-piper send <job> (--prompt-file F | --prompt TEXT) [--request-id ID]
pi-piper status [job]
pi-piper cancel <job>
pi-piper tail <job> [-n N]
pi-piper wait <job> --until settled|pr|any [--timeout S]
pi-piper watch [--since EVENT_ID] [--timeout S]
pi-piper ack <event-id>...
pi-piper pending
pi-piper loop <issue-url> --cwd DIR --leader MODEL --worker MODEL [--leader-thinking LEVEL] [--worker-thinking LEVEL] [--prompts DIR] [--dry-run]
pi-piper wait-loop <issue-key-or-url> [--timeout S]`;
type Command = { op: string; job?: string; cwd?: string; model?: string; thinking?: string;
  prompt?: string; requestId?: string; n?: number; until?: string; timeout?: number; since?: string; ids?: string[] };

function rpc(command: Command): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath: socket, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', part => { data += part; });
      res.on('end', () => {
        try {
          const value = JSON.parse(data);
          if (res.statusCode! >= 400) reject(new Error(value.error ?? 'Daemon request failed'));
          else resolve(value);
        } catch { reject(new Error('Invalid daemon response')); }
      });
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Daemon disconnected; restart it and repeat the command')));
    });
    req.on('error', () => reject(new Error('Daemon unavailable. Run: pi-piper daemon start')));
    req.end(JSON.stringify(command));
  });
}
function json(res: ServerResponse, value: unknown, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value) + '\n');
}
async function serve() {
  if (process.env.PIPER_LOCKED !== '1') throw new Error('Internal command: use pi-piper daemon start');
  process.umask(0o077);
  // flock is already held before opening the DB or removing a stale socket.
  rmSync(socket, { force: true });
  writeFileSync(pidFile, String(process.pid) + '\n', { mode: 0o600 });
  const runner = await Runner.open();
  let stopping = false;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/') return json(res, { error: 'Not found' }, 404);
      let body = '';
      for await (const part of req) {
        body += part;
        if (body.length > 2_000_000) throw new Error('Request too large');
      }
      const command = JSON.parse(body) as Command;
      if (command.op === 'health') return json(res, { status: 'running', pid: process.pid });
      if (command.op === 'stop') { json(res, { status: 'stopping', pid: process.pid }); void shutdown(); return; }
      if (stopping) return json(res, { error: 'Daemon stopping' }, 503);
      if (command.op === 'status') {
        const jobs = command.job ? [await runner.job(command.job)] : await runner.jobs();
        return json(res, await Promise.all(jobs.map(j => runner.status(j))));
      }
      if (command.op === 'pending') return json(res, await runner.pending());
      if (command.op === 'ack') return json(res, await runner.ack(command.ids!));
      if (command.op === 'watch') {
        if (command.since !== undefined && typeof command.since !== 'string') throw new Error('Invalid event cursor');
        if (command.timeout !== undefined) number(String(command.timeout), 0, 2_147_483);
        const controller = new AbortController();
        res.on('close', () => controller.abort());
        const result = await runner.watch(command.since, command.timeout, controller.signal);
        if (!res.destroyed) json(res, result);
        return;
      }
      if (!command.job || typeof command.job !== 'string') throw new Error('Job key required');
      if (command.op === 'start' || command.op === 'send') {
        if (typeof command.prompt !== 'string' || !command.prompt.trim()) throw new Error('Nonempty prompt required');
        if (typeof command.requestId !== 'string' || !command.requestId) throw new Error('Request id required');
        const job = command.op === 'start'
          ? await runner.start(command.job, realpathSync(command.cwd!), command.model!, command.thinking!)
          : await runner.job(command.job);
        return json(res, await runner.submit(job, command.prompt, command.requestId));
      }
      const job = await runner.job(command.job);
      if (command.op === 'cancel') return json(res, await runner.cancel(job));
      if (command.op === 'tail') return json(res, { transcript: await runner.tail(job, command.n ?? 20) });
      if (command.op === 'output') return json(res, await runner.output(job));
      if (command.op === 'wait') {
        const until = command.until ?? 'any';
        if (!['settled', 'pr', 'any'].includes(until)) throw new Error('Invalid --until');
        const target = await runner.latestSubmission(job);
        let finished = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          runner.notifications.off('event', listener);
          if (!res.destroyed) json(res, value);
        };
        const listener = (event: JobEvent) => {
          if (event.job === job.key && (event.type === 'pr_opened' ? until !== 'settled' : until !== 'pr' && event.submissionId === target)) finish(event);
        };
        runner.notifications.on('event', listener);
        res.on('close', () => { finished = true; clearTimeout(timer); runner.notifications.off('event', listener); });
        if (command.timeout !== undefined) timer = setTimeout(() => finish({ type: 'timeout', job: job.key }), command.timeout * 1000);
        const existing = await runner.matchingEvent(job, until, target);
        if (existing) finish(existing);
        return;
      }
      throw new Error('Unknown command');
    } catch (error) {
      // Only locally-authored validation messages are safe to expose. Provider errors may contain credentials.
      const message = error instanceof Error && /^(Unknown job:|Unknown model:|Job already|Invalid |Nonempty |Request id|Job key|Request too|Unknown command)/.test(error.message)
        ? error.message : 'Operation failed; check arguments and Pi login. Error details suppressed for credential safety.';
      if (!res.headersSent) json(res, { error: message }, 400);
    }
  });
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    await runner.close(); // Close, not abort: checkpoints stay resumable.
    rmSync(socket, { force: true });
    rmSync(pidFile, { force: true });
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  runner.harness.closed.then(end => {
    if (end.reason === 'failed') {
      console.error('Harness storage failed; restart the daemon to recover.');
      process.exit(1);
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  chmodSync(socket, 0o600);
  console.log(`${new Date().toISOString()} ready pid=${process.pid}`);
}
async function daemon(action: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (action === 'status') {
    try { console.log(JSON.stringify(await rpc({ op: 'health' }))); }
    catch { console.log(JSON.stringify({ status: 'stopped' })); process.exitCode = 1; }
    return;
  }
  if (action === 'stop') {
    let status;
    try { status = await rpc({ op: 'health' }); } catch { console.log('Daemon is stopped.'); return; }
    await rpc({ op: 'stop' });
    for (let i = 0; i < 150; i++) {
      try { process.kill(status.pid, 0); } catch { console.log('Daemon stopped.'); return; }
      // A detached child can briefly be a zombie. The socket/pid cleanup is authoritative.
      try { if (readFileSync(pidFile, 'utf8').trim() !== String(status.pid)) break; } catch { break; }
      await sleep(100);
    }
    console.log('Daemon stop requested.'); return;
  }
  if (action !== 'start') throw new Error(help);
  try { console.log(JSON.stringify(await rpc({ op: 'health' }))); return; } catch {}
  const fd = openSync(logFile, 'a', 0o600);
  const child = spawn('nohup', ['flock', '-n', '-F', join(home, 'daemon.lock'),
    join(nodeDir, 'node'), ...cliArgs('_serve')], {
    cwd: home, detached: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, PIPER_LOCKED: '1', PATH: `${nodeDir}:${process.env.PATH}` },
  });
  closeSync(fd);
  child.unref();
  child.on('error', () => console.error('Could not launch nohup/flock'));
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    try { console.log(JSON.stringify(await rpc({ op: 'health' }))); return; } catch {}
  }
  throw new Error(`Daemon did not become ready. See ${logFile}`);
}
function number(value: string | undefined, fallback: number, max: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error('Invalid numeric option');
  return n;
}
async function main() {
  const { positionals: args, values } = parseArgs({ allowPositionals: true, options: {
    cwd: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    model: { type: 'string' }, thinking: { type: 'string' }, 'request-id': { type: 'string' },
    until: { type: 'string' }, timeout: { type: 'string' }, n: { type: 'string', short: 'n' }, help: { type: 'boolean' },
    'dry-run': { type: 'boolean' }, since: { type: 'string' }, leader: { type: 'string' }, worker: { type: 'string' },
    'leader-thinking': { type: 'string' }, 'worker-thinking': { type: 'string' }, prompts: { type: 'string' },
  } });
  const [op, job] = args;
  if (values.help || !op) { console.log(help); return; }
  if (op === '_serve') return serve();
  if (op === 'daemon') return daemon(job);
  if (op === 'loop' || op === '_loop') {
    if (!job || !values.cwd) throw new Error('loop requires an issue URL and --cwd DIR');
    const cwd = realpathSync(resolve(values.cwd));
    if (!statSync(cwd).isDirectory()) throw new Error('--cwd must be a directory');
    const options = loadLoopOptions(cwd, {
      models: { ...(values.leader ? { leader: values.leader } : {}), ...(values.worker ? { worker: values.worker } : {}) },
      thinking: { ...(values['leader-thinking'] ? { leader: values['leader-thinking'] } : {}), ...(values['worker-thinking'] ? { worker: values['worker-thinking'] } : {}) },
      ...(values.prompts ? { promptDir: resolve(cwd, values.prompts) } : {}),
    });
    if (op === '_loop') await runLoop(job, cwd, values['dry-run'], undefined, options);
    else process.exitCode = await launchLoop(job, cwd, values['dry-run'] ?? false, [
      '--leader', options.models.leader, '--worker', options.models.worker,
      '--leader-thinking', options.thinking.leader, '--worker-thinking', options.thinking.worker,
      '--prompts', options.promptDir,
    ]);
    return;
  }
  if (op === 'wait-loop') {
    if (!job) throw new Error('wait-loop requires an issue key or URL');
    const event = await waitLoop(job, values.timeout === undefined ? undefined : number(values.timeout, 0, 2_147_483));
    console.log(JSON.stringify(event));
    if (event.type === 'timeout') process.exitCode = 2;
    return;
  }
  if (op === 'watch' || op === 'pending' || op === 'ack') {
    if ((op !== 'ack' && args.length !== 1) || (op === 'ack' && args.length < 2)) throw new Error(help);
    const result = await rpc({ op, ...(op === 'ack' ? { ids: args.slice(1) } : {}),
      ...(op === 'watch' ? { since: values.since,
        timeout: values.timeout === undefined ? undefined : number(values.timeout, 0, 2_147_483) } : {}) });
    for (const event of Array.isArray(result) ? result : [result]) console.log(JSON.stringify(event));
    if (result.type === 'timeout') process.exitCode = 2;
    return;
  }
  if (!['start', 'send', 'status', 'tail', 'wait', 'output', 'cancel'].includes(op) || (op !== 'status' && !job)) throw new Error(help);
  const command: Command = { op, job };
  if (op === 'start' || op === 'send') {
    if ((values.prompt !== undefined) === (values['prompt-file'] !== undefined)) throw new Error('Provide exactly one of --prompt or --prompt-file');
    command.prompt = values['prompt-file'] !== undefined ? readFileSync(resolve(values['prompt-file']), 'utf8') : values.prompt!;
    command.requestId = values['request-id'] ?? hash(JSON.stringify([job, command.prompt]));
    if (op === 'start') {
      if (!values.cwd) throw new Error('--cwd required');
      command.cwd = realpathSync(resolve(values.cwd));
      if (!statSync(command.cwd).isDirectory()) throw new Error('--cwd must be a directory');
      command.model = values.model ?? 'openai/gpt-4.1';
      command.thinking = values.thinking ?? 'high';
    }
  }
  if (op === 'tail') command.n = Math.max(1, Math.floor(number(values.n, 20, 1000)));
  if (op === 'wait') {
    command.until = values.until ?? 'any';
    if (!['settled', 'pr', 'any'].includes(command.until)) throw new Error('Invalid --until');
    if (values.timeout !== undefined) command.timeout = number(values.timeout, 0, 2_147_483);
  }
  const result = await rpc(command);
  if (op === 'tail') console.log(result.transcript);
  else console.log(JSON.stringify(result));
  if (result.type === 'timeout') process.exitCode = 2;
}
main().catch(error => {
  // Do not log arbitrary error objects, causes, headers, or ModelRuntime state.
  console.error(process.argv.includes('_serve') ? 'Daemon initialization failed (details suppressed for credential safety).' : error instanceof Error ? error.message : 'pi-piper failed');
  process.exitCode = 1;
});
