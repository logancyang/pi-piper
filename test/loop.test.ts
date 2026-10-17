import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { issueKey, nextAction, parseVerdict, repeats } from '../src/loop-policy.js';
import { runLoop } from '../src/loop.js';
import { loadLoopOptions, promptPath } from '../src/loop-config.js';
import { load, type LoopIO } from '../src/loop-io.js';
const f = load(new URL('./fixtures/loop.json', import.meta.url).pathname);
const url = 'https://github.com/owner/repo/issues/42', key = issueKey(url);
const temporary = () => mkdtempSync(join(tmpdir(), 'piper-loop-'));
const fix = (finding = f.finding) => `DECLINED: []\nVERDICT: FIX ${JSON.stringify([finding])}`;
test('verdict parser: fixtures, five-finding limit, duplicate ids and declined reasons', () => {
  assert.deepEqual(f.valid.map((s: string) => parseVerdict(s).kind), ['ACCEPT', 'FIX', 'REJECT', 'SPLIT']);
  assert.equal(parseVerdict(f.valid[0]).declined[0].reason, 'Narrow edge case outside the outcome');
  assert.match(parseVerdict(f.valid[1]).findings[0].instructions, /test\/save.test.ts/);
  for (const instructions of [undefined, null, '', '  ', 42])
    assert.throws(() => parseVerdict(fix({ ...f.finding, instructions })), /concrete instructions/);
  const grouped = { ...f.finding, root_ids: [42, 81] };
  assert.deepEqual(parseVerdict(fix(grouped)).findings[0].root_ids, [42, 81]);
  for (const root_ids of [[], [0], [-1], ['42'], [42, 42], [1.5], null, 42])
    assert.throws(() => parseVerdict(fix({ ...f.finding, root_ids })));
  for (const text of f.invalid) assert.throws(() => parseVerdict(text), text);
  assert.throws(() => parseVerdict(`VERDICT: FIX ${JSON.stringify(Array(6).fill(f.finding))}`));
  assert.throws(() => parseVerdict(`VERDICT: FIX ${JSON.stringify(Array(2).fill(f.finding))}`));
  assert.throws(() => parseVerdict('VERDICT: FIX [{"title":"Missing id","file":"a"}]'));
  assert.throws(() => issueKey('https://github.com/o/r/pull/1'));
});
test('loop config resolves role/model aliases, prompt files, user guidance and caps', () => {
  const cwd = temporary();
  try {
    writeFileSync(join(cwd, 'piper.config.json'), JSON.stringify({
      roles: { leader: { model: 'provider/strategist', thinking: 'high' }, worker: { model: 'provider/builder', thinking: 'low' } },
      prompts: { leaderPlan: 'custom-plan.md', reviewGuidance: '~/review.md' },
      caps: { maxFixRounds: 1, maxFindings: 2, sizeBudget: 250 },
    }));
    const options = loadLoopOptions(cwd, { models: { worker: 'provider/override' }, promptDir: 'prompts' });
    assert.deepEqual(options.models, { leader: 'provider/strategist', worker: 'provider/override' });
    assert.deepEqual(options.thinking, { leader: 'high', worker: 'low' });
    assert.equal(options.caps.maxFixRounds, 1); assert.equal(options.caps.maxFindings, 2); assert.equal(options.caps.sizeBudget, 250);
    assert.equal(promptPath(options, 'leaderPlan'), join(cwd, 'prompts/custom-plan.md'));
    assert.ok(promptPath(options, 'reviewGuidance').endsWith('/review.md'));
    assert.throws(() => loadLoopOptions(cwd, { thinking: { leader: 'bogus' } }));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('caps and single-redesign policy fixtures', () => {
  for (const c of f.caps) assert.equal(nextAction({ ...parseVerdict(f.valid[0]), kind: c.kind },
    c.reviews, c.fixes, c.repeated, c.redesigned), c.action, JSON.stringify(c));
});
test('repeat detection uses stable id OR normalized file/title', () => {
  assert.ok(repeats([{ ...f.finding, file: 'other.ts', title: 'different wording' }], [f.finding]));
  assert.ok(repeats([f.alias], [f.finding]));
  assert.ok(!repeats([f.different], [f.finding]));
  assert.ok(!repeats([f.finding], []));
});
async function scenario(outputs: string[], interrupt = false) {
  const cwd = temporary(), dir = join(cwd, '.piper-loop', key), ids: string[] = [], prompts: string[] = [], roles: string[] = [];
  mkdirSync(dir, { recursive: true });
  const receipts = new Map<string, string>();
  let interrupted = false;
  const io: LoopIO = {
    async turn(role, id, prompt) {
      ids.push(id); prompts.push(prompt); roles.push(role);
      if (!receipts.has(id)) receipts.set(id, outputs.shift()!);
      if (id.includes(':plan:')) writeFileSync(join(dir, 'plan.md'), 'Detailed fixture handoff spec');
      if (interrupt && !interrupted && id.includes(':implement:')) { interrupted = true; throw new Error('simulated disconnect after admission'); }
      assert.ok(receipts.get(id), `Unexpected turn ${id}`);
      return { text: receipts.get(id)!, turns: receipts.size };
    },
    async context(_pr, _head, last, seen) { return { base: last ?? '0'.repeat(40), comments: [], seen }; },
    async pending() {},
  };
  try {
    if (interrupt) await assert.rejects(runLoop(url, cwd, true, io), /simulated disconnect/);
    const state = await runLoop(url, cwd, true, io);
    const before = ids.length;
    await runLoop(url, cwd, true, io);
    assert.equal(ids.length, before, 'completed loop must not submit again');
    assert.equal(load(join(dir, 'state.json')).step, 'done');
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 1);
    return { state, ids, prompts, roles };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}
const plan = 'VERDICT: ACCEPT';
const implemented = `PR: https://github.com/owner/implementation/pull/7\nHEAD: ${'a'.repeat(40)}`;
const fixed1 = `HEAD: ${'b'.repeat(40)}`, fixed2 = `HEAD: ${'c'.repeat(40)}`;
test('repeat gets exactly one explicit redesign, then escalates within 2 fixes/3 reviews', async () => {
  const { state, ids, prompts } = await scenario([plan, implemented, fix(), fixed1, fix(f.alias), fix(), fixed2, fix()]);
  assert.match(state.verdict!, /^ESCALATED/);
  assert.equal(state.fixes, 2); assert.equal(state.reviews, 3);
  assert.equal(ids.filter(id => id.includes(':redesign:')).length, 1);
  assert.ok(prompts.some(p => p.includes('Exactly one redesign attempt')));
});
test('nonrepeating findings still stop at cap; post-PR REJECT escalates; SPLIT never implements', async () => {
  const capped = await scenario([plan, implemented, fix(), fixed1, fix(f.different), fixed2, fix({ ...f.different, id: 'third', title: 'Third problem' })]);
  assert.equal(capped.state.fixes, 2); assert.equal(capped.state.reviews, 3);
  assert.match(capped.state.verdict!, /^ESCALATED/);
  const rejected = await scenario([plan, implemented, 'VERDICT: REJECT Needs a separate design']);
  assert.match(rejected.state.verdict!, /ESCALATED: Needs a separate design/);
  assert.equal(rejected.state.fixes, 0);
  const split = await scenario(['VERDICT: SPLIT']);
  assert.equal(split.ids.length, 1); assert.match(split.state.verdict!, /^SPLIT/);
});
test('Leader prompt requires immediate accepted/declined replies, root-specific resume checks and zero pending reviews', async () => {
  const { prompts } = await scenario([plan, implemented, fix({ ...f.finding, root_ids: [42, 81] }), fixed1, 'VERDICT: ACCEPT']);
  const review = prompts[2];
  assert.match(review, /Triage every new inline comment/);
  assert.match(review, /reply during this review step/);
  assert.match(review, /accepted comments get the concrete plan forward/);
  assert.match(review, /declined comments get the reason/);
  assert.match(review, /Preserve every accepted thread root/);
  assert.ok(prompts[3].includes('"root_ids":[42,81]'));
});
test('review resume reuses Leader output and clears the PENDING barrier before Worker can fix', async () => {
  const cwd = temporary(), dir = join(cwd, '.piper-loop', key), order: string[] = [];
  mkdirSync(dir, { recursive: true });
  const outputs = [plan, implemented, fix({ ...f.finding, root_ids: [42, 81] }), fixed1, 'VERDICT: ACCEPT'];
  let blocked = true, cleared = false;
  const io: LoopIO = {
    async turn(role, id) {
      order.push(role + ':' + id.split(':')[2]);
      if (id.includes(':plan:')) writeFileSync(join(dir, 'plan.md'), 'Fixture handoff');
      if (id.includes(':fix:')) assert.ok(cleared, 'Worker cannot fix until Leader review has passed the pending gate');
      return { text: outputs.shift()!, turns: order.length };
    },
    async context(_pr, _head, last, seen) { return { base: last ?? '0'.repeat(40), comments: [], seen }; },
    async pending() {
      if (blocked) { order.push('pending:blocked'); blocked = false; throw new Error('PENDING review'); }
      order.push('pending:clear'); cleared = true;
    },
  };
  try {
    await assert.rejects(runLoop(url, cwd, true, io), /PENDING review/);
    assert.deepEqual(order, ['leader:plan', 'worker:implement', 'leader:review', 'pending:blocked']);
    assert.equal(load(join(dir, 'state.json')).step, 'review');
    await runLoop(url, cwd, true, io);
    assert.deepEqual(order, ['leader:plan', 'worker:implement', 'leader:review', 'pending:blocked',
      'pending:clear', 'worker:fix', 'leader:review', 'pending:clear']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('Leader hands Worker explicit code/test/command instructions without design judgment', async () => {
  const { state, prompts, roles, ids } = await scenario([plan, implemented, fix(), fixed1, 'VERDICT: ACCEPT']);
  assert.deepEqual(roles, ['leader', 'worker', 'leader', 'worker', 'leader']);
  assert.equal(state.implementer, 'worker');
  assert.ok(ids.every(id => id.startsWith(`${key}:worker:`)));
  assert.match(prompts[0], /files\/functions/);
  assert.match(prompts[0], /code shape/);
  assert.match(prompts[0], /regression tests/);
  assert.match(prompts[0], /commands/);
  assert.match(prompts[0], /explicit non-goals/);
  assert.doesNotMatch(prompts[0], /Keep it to one page/);
  assert.match(prompts[2], /concrete instructions/);
  assert.match(prompts[3], /Execute each finding's instructions exactly/);
  assert.ok(prompts[3].includes(JSON.stringify(f.finding)));
});
test('pre-Worker persisted state is rejected before any model call', async () => {
  const cwd = temporary(), dir = join(cwd, '.piper-loop', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ issue: url, cwd, dry: true, step: 'implement' }));
  try { await assert.rejects(runLoop(url, cwd, true), /predates the Worker handoff spec/); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});
test('resume reuses frozen request id and prompt after disconnect', async () => {
  const { state, ids, prompts } = await scenario([plan, implemented, 'VERDICT: ACCEPT'], true);
  assert.equal(state.verdict, 'ACCEPT');
  assert.equal(ids[1], ids[2]); assert.equal(prompts[1], prompts[2]);
});
test('CLI --dry-run exercises plan/implement/review/fix/review with no network or daemon', () => {
  const cwd = temporary(), bin = join(cwd, 'bin');
  mkdirSync(bin);
  for (const name of ['gh', 'git', 'piper', 'pi-piper']) {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\necho UNEXPECTED_EXTERNAL_CALL >&2\nexit 99\n'); chmodSync(path, 0o755);
  }
  const cli = new URL('../src/main.ts', import.meta.url).pathname;
  const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
  const args = ['--import', loader, cli, 'loop', url, '--cwd', cwd, '--leader', 'openai/test-leader', '--worker', 'openai/test-worker', '--dry-run'];
  try {
    const output = execFileSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.match(output, /Verdict: ACCEPT/);
    const dir = join(cwd, '.piper-loop', key), s = load(join(dir, 'state.json'));
    assert.equal(s.fixes, 1); assert.equal(s.reviews, 2);
    assert.equal(s.declined[0].id, 'narrow-case');
    assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Outside the required outcome/);
    const stateBefore = readFileSync(join(dir, 'state.json'), 'utf8');
    execFileSync(process.execPath, args, { stdio: 'pipe' });
    assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), stateBefore);
    assert.equal(lstatSync(dir).isDirectory(), true);
    assert.throws(() => execFileSync(process.execPath, ['--import', loader, cli, 'loop', url, '--cwd', cwd, '--leader', 'openai/test-leader', '--worker', 'openai/test-worker'], { stdio: 'pipe' }));
    assert.throws(() => execFileSync(process.execPath, ['--import', loader, cli, 'wait-loop', 'fixture-never-finished-999', '--timeout', '0'], { encoding: 'utf8', stdio: 'pipe' }), (error: any) => {
      assert.equal(error.status, 2); assert.equal(JSON.parse(error.stdout.toString()).type, 'timeout'); return true;
    });
    mkdirSync(join(cwd, '.pi-piper'));
    writeFileSync(join(cwd, '.pi-piper/events.jsonl'), JSON.stringify({ type: 'loop_finished', issue: key }) + '\n');
    const finished = execFileSync(process.execPath, ['--import', loader, cli, 'wait-loop', key, '--timeout', '0'], {
      encoding: 'utf8', env: { ...process.env, HOME: cwd },
    });
    assert.equal(JSON.parse(finished).type, 'loop_finished');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
