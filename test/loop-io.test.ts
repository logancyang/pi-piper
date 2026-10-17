import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { liveIO } from '../src/loop-io.js';

test('loop jobs select Leader/Worker models with high thinking (stub Unix-socket daemon)', { timeout: 60_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'piper-models-')), oldHome = process.env.HOME;
  mkdirSync(join(cwd, '.pi-piper'));
  const commands: any[] = [];
  let eventType = 'done';
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const command = JSON.parse(body); commands.push(command);
    res.end(JSON.stringify(command.op === 'wait' ? { type: eventType, requestId: 'fixture' } :
      command.op === 'output' ? { text: 'fixture output\nSTATUS: DONE\n', turns: 1 } : { status: 'done' }));
  });
  try {
    await new Promise<void>(resolve => server.listen(join(cwd, '.pi-piper/daemon.sock'), resolve));
    process.env.HOME = cwd;
    const models = { leader: 'vendor/leader-model', worker: 'vendor/worker-model' };
    const io = liveIO(cwd, 'owner-repo-42', cwd, models, { leader: 'low', worker: 'minimal' });
    for (const role of ['leader', 'worker'] as const) {
      assert.equal((await io.turn(role, 'fixture', 'fixture prompt')).text, 'fixture output');
      const start = commands.find(c => c.op === 'start' && c.job === `owner-repo-42-${role}`);
      assert.equal(start.model, models[role]);
      assert.equal(start.thinking, role === 'leader' ? 'low' : 'minimal'); assert.equal(start.cwd, cwd);
    }
    assert.deepEqual(commands.map(c => c.op), ['start', 'wait', 'output', 'start', 'wait', 'output']);
    assert.ok(commands.filter(c => c.op === 'wait').every(c => c.until === 'settled'));
    for (eventType of ['needs_input', 'blocked', 'failed']) {
      await assert.rejects(io.turn('worker', 'fixture', 'fixture prompt'), new RegExp(`did not complete.*${eventType}`));
      assert.equal(commands.at(-1).op, 'wait', 'non-done turns cannot advance the loop');
    }
  } finally {
    process.env.HOME = oldHome;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('GitHub adapter: human/Codex inline cursors, reply root ids/markers, incremental diff and pending-review gate (stub executables)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'piper-gh-')), bin = join(cwd, 'bin'), oldPath = process.env.PATH;
  mkdirSync(bin);
  const head = 'a'.repeat(40), prior = 'b'.repeat(40), pr = 'https://github.com/owner/implementation/pull/7';
  const data = {
    metadata: { draft: false, state: 'open', merged: false, head: { sha: head }, base: { sha: '0'.repeat(40) } },
    comments: [
      { id: 10, user: { login: 'human' }, body: 'Root' },
      { id: 11, in_reply_to_id: 10, user: { login: 'human' } },
      { id: 12, in_reply_to_id: 11, user: { login: 'chatgpt-codex-connector[bot]' }, body: 'A new problem', commit_id: head, updated_at: 'now' },
      { id: 13, user: { login: 'reviewer' }, body: 'Human finding', commit_id: head, updated_at: 'now' },
      { id: 14, in_reply_to_id: 13, user: { login: 'human' }, body: 'Accepted: change save. <!-- piper-leader-triage:13 -->', updated_at: 'now' },
      { id: 15, in_reply_to_id: 10, user: { login: 'human' }, body: `Fixed in ${head}`, updated_at: 'now' },
    ],
    reviews: [{ id: 20, user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: head, state: 'COMMENTED', submitted_at: 'now' },
      { id: 21, user: { login: 'reviewer' }, commit_id: head, state: 'COMMENTED', submitted_at: 'now' }],
    general: [{ id: 30, user: { login: 'chatgpt-codex-connector[bot]' }, body: 'Overall comment', updated_at: 'now' },
      { id: 31, user: { login: 'reviewer' }, body: 'Not an inline review', updated_at: 'now' }],
  };
  const dataFile = join(cwd, 'data.json');
  writeFileSync(dataFile, JSON.stringify(data));
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const d = JSON.parse(require('fs').readFileSync(${JSON.stringify(dataFile)}, 'utf8'));
const endpoint = process.argv.at(-1).split('?')[0];
const rows = endpoint.endsWith('/reviews') ? d.reviews : endpoint.endsWith('/comments') ? (endpoint.includes('/issues/') ? d.general : d.comments) : null;
console.log(JSON.stringify(rows ? [rows] : d.metadata));
`);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') console.log('${head}');
else if (args[0] === 'merge-base') console.log('${'0'.repeat(40)}');
else if (args[0] === 'diff') console.log(args[1]);
else process.exit(99);
`);
  chmodSync(join(bin, 'gh'), 0o755); chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const io = liveIO(cwd, 'owner-repo-42', cwd, { leader: 'vendor/leader', worker: 'vendor/worker' }, { leader: 'high', worker: 'high' });
    const first = await io.context(pr, head, undefined, [], Date.now() + 10_000);
    assert.equal(first.comments.length, 8);
    assert.deepEqual(first.comments.filter(c => c.kind === 'inline').map(c => [c.id, c.root_id]),
      [[10, 10], [11, 10], [12, 10], [13, 13], [14, 13], [15, 10]]);
    assert.match(String(first.comments.find(c => c.id === 14)!.body), /<!-- piper-leader-triage:13 -->/);
    assert.equal(first.comments.some(c => c.id === 21 || c.id === 31), false);
    assert.equal(first.comments.find(c => c.kind === 'review')!.root_id, null);
    assert.equal(first.base, '0'.repeat(40));
    const second = await io.context(pr, head, prior, first.seen, Date.now() - 1);
    assert.equal(second.comments.length, 0);
    assert.equal(readFileSync(join(cwd, 'review.diff'), 'utf8'), `${prior}..${head}`);
    data.comments[3].updated_at = 'later';
    data.comments.push({ id: 16, in_reply_to_id: 14, user: { login: 'reviewer' }, body: 'New follow-up', updated_at: 'later' });
    writeFileSync(dataFile, JSON.stringify(data));
    const updated = await io.context(pr, head, prior, second.seen, Date.now() - 1);
    assert.deepEqual(updated.comments.map(c => [c.id, c.root_id]), [[13, 13], [16, 13]]);
    assert.equal((await io.context(pr, head, prior, updated.seen, Date.now() - 1)).comments.length, 0);
    await io.pending(pr);
    data.reviews[0].state = 'PENDING'; writeFileSync(dataFile, JSON.stringify(data));
    await assert.rejects(io.pending(pr), /Pending GitHub review/);
    data.metadata.draft = true; writeFileSync(dataFile, JSON.stringify(data));
    await assert.rejects(io.context(pr, head, prior, [], Date.now()), /open, non-draft/);
  } finally { process.env.PATH = oldPath; rmSync(cwd, { recursive: true, force: true }); }
});
