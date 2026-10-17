import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { issueKey } from './loop-policy.js';
import { cliArgs } from './self.js';
import type { Role } from './loop-config.js';
const exec = promisify(execFile);
export const eventFile = join(process.env.PIPER_HOME || join(homedir(), '.pi-piper'), 'events.jsonl');
export const load = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
export function save(path: string, value: unknown) {
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path);
}
export async function command(executable: string, args: string[], cwd: string, timeout = 30_000) {
  const { stdout } = await exec(executable, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
const runCli = async (args: string[], cwd: string, timeout = 30_000) =>
  JSON.parse(await command(process.execPath, cliArgs(...args), cwd, timeout));
export type Output = { text: string; turns: number; tokens?: number };
export type Comment = { key: string; kind: string; root_id: number | null; [key: string]: unknown };
export type Context = { base: string; comments: Comment[]; seen: string[] };
export interface LoopIO {
  turn(role: 'leader' | 'worker', id: string, prompt: string): Promise<Output>;
  context(pr: string, head: string, last: string | undefined, seen: string[], deadline: number): Promise<Context>;
  pending(pr: string): Promise<void>;
}
export function liveIO(cwd: string, key: string, dir: string, models: Record<Role, string>, thinking: Record<Role, string>): LoopIO {
  const api = async (endpoint: string) => JSON.parse(await command('gh', ['api', endpoint], cwd));
  const pages = async (endpoint: string, timeout = 30_000): Promise<any[]> =>
    JSON.parse(await command('gh', ['api', '--paginate', '--slurp', endpoint + '?per_page=100'], cwd, timeout)).flat();
  const prPath = (pr: string) => {
    const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/.exec(pr);
    if (!m) throw new Error('Invalid PR URL');
    return `repos/${m[1]}/pulls/${m[2]}`;
  };
  return {
    async turn(role, id, prompt) {
      const job = `${key}-${role}`;
      await runCli(['start', job, '--cwd', cwd, '--model', models[role],
        '--thinking', thinking[role], '--request-id', id, '--prompt', prompt], cwd);
      const event = await runCli(['wait', job, '--until', 'settled'], cwd, 0);
      if (event.type !== 'done' || event.requestId !== id) throw new Error(`Job ${job} did not complete for ${id}: ${event.question ?? event.reason ?? event.type}`);
      const output: Output = await runCli(['output', job], cwd);
      // Task-specific parsers still see VERDICT/HEAD as their final line.
      return { ...output, text: output.text.trimEnd().replace(/(?:^|\n)STATUS: DONE$/, '') };
    },
    async context(pr, head, last, seen, deadline) {
      const path = prPath(pr), meta = await api(path);
      if (meta.draft !== false || meta.state !== 'open' || meta.merged || meta.head.sha !== head ||
        await command('git', ['rev-parse', 'HEAD'], cwd) !== head) throw new Error('PR must be open, non-draft, and match local/reported HEAD');
      const base = last ?? await command('git', ['merge-base', meta.base.sha, head], cwd);
      let comments: Comment[] = [];
      // After a restart past the deadline, take one bounded snapshot, but never restart the wait.
      const end = deadline > Date.now() ? deadline : Date.now() + 30_000;
      do {
        try {
          const poll = (endpoint: string) => pages(endpoint, Math.max(1, Math.min(30_000, end - Date.now())));
          const inline = await poll(`${path}/comments`);
          const reviews = await poll(`${path}/reviews`);
          const general = await poll(path.replace('/pulls/', '/issues/') + '/comments');
          const byId = new Map(inline.map(c => [c.id, c]));
          const rootId = (c: any): number => c.in_reply_to_id ? rootId(byId.get(c.in_reply_to_id) ?? { id: c.in_reply_to_id }) : c.id;
          comments = [
            ...inline.map(c => ({ ...c, kind: 'inline', root_id: rootId(c) })),
            ...reviews.map(c => ({ ...c, kind: 'review', root_id: null })),
            ...general.map(c => ({ ...c, kind: 'conversation', root_id: null })),
          ].filter(c => c.kind === 'inline' || /codex/i.test(c.user?.login ?? '')).map(c => ({ ...c, key: `${c.kind}:${c.id}:${c.updated_at ?? c.submitted_at ?? ''}` }))
            .filter(c => !seen.includes(c.key));
        } catch (error) { if (Date.now() < end) throw error; break; }
        if (comments.some(c => /codex/i.test((c.user as { login?: string })?.login ?? '') && c.commit_id === head) || Date.now() >= deadline) break;
        await sleep(Math.max(0, Math.min(60_000, deadline - Date.now())));
      } while (Date.now() < deadline);
      writeFileSync(join(dir, 'review.diff'), await command('git', ['diff', `${base}..${head}`], cwd));
      return { base, comments, seen: [...seen, ...comments.map(c => c.key)] };
    },
    async pending(pr) {
      const reviews = await pages(`${prPath(pr)}/reviews`);
      if (reviews.some(r => r.state === 'PENDING')) throw new Error('Pending GitHub review remains; publish or remove it before resuming');
    },
  };
}
// A deterministic local rehearsal, never a network/model call. It deliberately takes one fix round.
export function dryIO(dir: string): LoopIO {
  const turns = { leader: 0, worker: 0 };
  return {
    async turn(role, id) {
      turns[role]++;
      if (id.includes(':plan:')) writeFileSync(join(dir, 'plan.md'), '# Dry-run plan\nRequired outcome: exercise the loop without external effects.\n');
      const text = id.includes(':plan:') ? 'VERDICT: ACCEPT' : id.includes(':implement:') ?
        `PR: https://github.com/piper-fixture/offline/pull/1\nHEAD: ${'a'.repeat(40)}` : role === 'worker' ?
        `HEAD: ${'b'.repeat(40)}` : id.includes(':review:0:') ?
        'DECLINED: [{"id":"narrow-case","reason":"Outside the required outcome"}]\nVERDICT: FIX [{"id":"missing-outcome","title":"Deliver the required outcome","file":"fixture.ts","instructions":"In fixture.ts, implement outcome(): boolean as return true. Add test/fixture.test.ts test outcome returns true asserting outcome() === true. Run npm run check, npm test and npm run build; lint is not configured in this fixture. Do not add options or dependencies."}]' : 'DECLINED: []\nVERDICT: ACCEPT';
      return { text, turns: turns[role] };
    },
    async context(_pr, _head, last) { return { base: last ?? '0'.repeat(40), comments: [], seen: [] }; },
    async pending() {},
  };
}
export async function launchLoop(url: string, cwd: string, dry: boolean, args: string[]) {
  const dir = join(cwd, '.piper-loop', issueKey(url));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const child = spawn('flock', ['-n', '-F', join(dir, 'loop.lock'), process.execPath, ...cliArgs(
    '_loop', url, '--cwd', cwd, ...args, ...(dry ? ['--dry-run'] : []))], { stdio: 'inherit' });
  return new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
}
export async function ignoreState(cwd: string) {
  const path = await command('git', ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], cwd);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || !readFileSync(path, 'utf8').split('\n').includes('.piper-loop/')) appendFileSync(path, '\n.piper-loop/\n');
}
export function events(path: string): any[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function waitLoop(issue: string, timeout?: number) {
  const key = issue.startsWith('https://') ? issueKey(issue) : issue;
  const deadline = timeout === undefined ? Infinity : Date.now() + timeout * 1000;
  do {
    const found = events(eventFile).find(e => e.issue === key && ['loop_finished', 'loop_escalated'].includes(e.type));
    if (found) return found;
    if (Date.now() >= deadline) return { type: 'timeout', issue: key };
    await sleep(Math.min(1000, deadline - Date.now()));
  } while (true);
}
