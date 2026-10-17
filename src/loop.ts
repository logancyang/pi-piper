import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueKey, nextAction, parseVerdict, repeats, type Declined, type Finding } from './loop-policy.js';
import { loadLoopOptions, promptPath, type LoopOptions, type Role } from './loop-config.js';
import { dryIO, eventFile, events, ignoreState, liveIO, load, save, type Context, type LoopIO, type Output } from './loop-io.js';
type Step = 'design' | 'plan' | 'implement' | 'codex' | 'review' | 'redesign' | 'fix' | 'done';
export type State = {
  issue: string; cwd: string; dry: boolean; implementer: 'worker'; step: Step; reviews: number; fixes: number; redesigned: boolean;
  fixed: Finding[]; findings: Finding[]; declined: Declined[]; seen: string[]; usage: Partial<Record<Role, Output>>;
  pr?: string; head?: string; lastReviewed?: string; deadline?: number; context?: Context; verdict?: string;
  pending?: { id: string; role: Role; prompt: string; output?: Output };
  settings?: LoopOptions;
};
const headFrom = (text: string) => {
  const sha = /(?:^|\n)HEAD: ([a-f0-9]{40})$/.exec(text.trim())?.[1];
  if (!sha) throw new Error('Missing HEAD: <40-character sha>');
  return sha;
};
export async function runLoop(url: string, cwd: string, dry = false, ioOverride?: LoopIO, options?: LoopOptions) {
  cwd = realpathSync(cwd);
  const key = issueKey(url), dir = join(cwd, '.piper-loop', key), path = join(dir, 'state.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = options ?? loadLoopOptions(cwd);
  const architect = Boolean(settings.models.architect);
  const s: State = existsSync(path) ? load(path) : { issue: url, cwd, dry, implementer: 'worker', step: architect ? 'design' : 'plan', reviews: 0, fixes: 0,
    redesigned: false, fixed: [], findings: [], declined: [], seen: [], usage: {}, settings };
  if (s.cwd !== cwd || s.issue !== url || s.dry !== dry) throw new Error('Loop state does not match cwd/issue/dry-run mode');
  if (s.implementer !== 'worker') throw new Error('Loop state predates the Worker handoff spec; human inspection/migration required before resuming');
  if (s.settings && JSON.stringify(s.settings) !== JSON.stringify(settings)) throw new Error('Loop config changed since this run started; restore its original settings before resuming');
  s.settings ??= settings;
  const persist = () => save(path, s);
  const io = ioOverride ?? (dry ? dryIO(dir) : liveIO(cwd, key, dir, settings.models, settings.thinking));
  const prompt = (name: keyof LoopOptions['promptFiles']) => {
    const file = promptPath(settings, name);
    return file ? readFileSync(file, 'utf8') : '';
  };
  const optionalGuidance = (name: 'reviewGuidance' | 'prDescription' | 'architectIdentity') => {
    const file = promptPath(settings, name);
    return file ? `\n\nUser-provided ${name} guidance (${file}):\n${readFileSync(file, 'utf8')}` : '';
  };
  const plan = join(dir, 'plan.md'), design = join(dir, 'design.md');
  const roles = architect ? 'Architect designs; leader plans from the design and reviews; worker implements.' : 'Leader plans and reviews; worker implements.';
  const common = `Issue: ${url}\n${architect ? `Design: ${design}\n` : ''}Plan: ${plan}\nWork only in ${cwd}. Keep .piper-loop local. ${roles} Reply to every triaged comment and report each pushed fix as Fixed in <sha>. Keep pull requests ready and never merge.\n`;
  async function turn(role: Role, content: string) {
    s.pending ??= { role, id: `${key}:worker:${s.step}:${s.reviews}:${s.fixes}`, prompt: common + content };
    persist(); // Freeze the prompt before admission: a crash resubmits exactly the same request id/content.
    if (!s.pending.output) {
      s.pending.output = await io.turn(s.pending.role, s.pending.id, s.pending.prompt);
      s.usage[role] = s.pending.output;
      persist();
    }
    return s.pending.output.text;
  }
  function advance(step: Step) { s.step = step; delete s.pending; persist(); }
  function finish(verdict: string) { s.verdict = verdict; advance('done'); }
  if (!dry && s.step !== 'done') await ignoreState(cwd);
  persist();
  while (s.step !== 'done') {
    switch (s.step) {
      case 'design': {
        const identity = optionalGuidance('architectIdentity').trimStart();
        const v = parseVerdict(await turn('architect', `${identity ? identity + '\n\n' : ''}${prompt('architectDesign')}\n\nWrite the design doc to ${design}. Do not write code or change any other file. Size budget: the design should be buildable in no more than ${settings.caps.sizeBudget} changed non-test lines; propose SPLIT if the issue needs more.
End with VERDICT: ACCEPT once ${design} is written, VERDICT: SPLIT, or VERDICT: REJECT <the decision a human must make first>.`), settings.caps.maxFindings);
        if (v.kind === 'SPLIT') finish('SPLIT: human must choose the proposed PR split');
        else if (v.kind === 'REJECT') finish(`ESCALATED: architect needs a decision: ${v.summary}`);
        else if (v.kind !== 'ACCEPT') throw new Error('Design must end with ACCEPT, SPLIT, or REJECT');
        else if (!existsSync(design)) throw new Error('Architect did not write design.md');
        else advance('plan');
        break;
      }
      case 'plan': {
        const followDesign = architect ? `\n\nThe architect's design is in ${design}. Follow its decision, user flow, compatibility line, and plan; turn them into the detailed handoff without redesigning. If the design cannot be followed, end with VERDICT: REJECT <why> instead.` : '';
        const v = parseVerdict(await turn('leader', `${prompt('leaderPlan')}${followDesign}\n\nSize budget: aim for no more than ${settings.caps.sizeBudget} changed non-test lines. Propose SPLIT if the issue needs more.`), settings.caps.maxFindings);
        if (architect && v.kind === 'REJECT') { finish(`ESCALATED: plan cannot follow design: ${v.summary}`); break; }
        if (!existsSync(plan)) throw new Error('Leader did not write plan.md');
        if (v.kind === 'SPLIT') finish('SPLIT: human must choose the proposed PR split');
        else if (v.kind === 'ACCEPT') advance('implement');
        else throw new Error('Plan must end with ACCEPT or SPLIT');
        break;
      }
      case 'implement': {
        const text = await turn('worker', `${prompt('workerImplement')}\n\nStay within the ${settings.caps.sizeBudget}-line changed non-test size budget. Execute plan.md's handoff spec exactly: change only the named files/functions using the specified signatures and logic, add the exact named regression tests, and run the specified lint/typecheck/tests/build commands. Obey its explicit don'ts. Do not make design decisions or invent missing details; if the spec is ambiguous or cannot be followed, stop and report the blocker.
Use this built-in guidance: ${prompt('triage')}${optionalGuidance('reviewGuidance')}${optionalGuidance('prDescription')} Commit your work, open a ready PR using the available GitHub CLI, and report its URL and full HEAD. Never merge. End with exactly these two lines:
PR: <https://github.com/OWNER/REPO/pull/NUMBER>
HEAD: <full sha>`);
        const pr = /(?:^|\n)PR: (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)\nHEAD: [a-f0-9]{40}$/.exec(text.trim())?.[1];
        if (!pr) throw new Error('Missing PR: <url>');
        s.pr = pr; s.head = headFrom(text); s.deadline = Date.now() + 900_000;
        advance('codex'); break;
      }
      case 'codex': {
        s.context = await io.context(s.pr!, s.head!, s.lastReviewed, s.seen, s.deadline!);
        save(join(dir, 'review-input.json'), s.context);
        advance('review'); break;
      }
      case 'review': {
        if (s.reviews >= settings.caps.maxFixRounds + 1) { finish('ESCALATED: review cap'); break; }
        const v = parseVerdict(await turn('leader', `${prompt('leaderReview')}\n\n${prompt('triage')}${optionalGuidance('reviewGuidance')}` + `
PR: ${s.pr}\nHEAD: ${s.head}\nReview only git diff ${s.context!.base}..HEAD (saved as ${join(dir, 'review.diff')}).
Read plan.md${architect ? ` and design.md (raise any deviation from its decision, user flow, or compatibility line as a finding)` : ''} and ${join(dir, 'review-input.json')} for every new inline review comment (Codex or human), plus Codex reviews/conversation comments, and each thread's root_id.
Previously fixed findings: ${JSON.stringify(s.fixed)}\nRedesign already used: ${s.redesigned}`), settings.caps.maxFindings);
        if (v.kind === 'SPLIT') throw new Error('SPLIT is only valid before implementation');
        await io.pending(s.pr!);
        s.reviews++; s.lastReviewed = s.head; s.seen = s.context!.seen;
        s.declined.push(...v.declined); s.findings = v.findings;
        const action = nextAction(v, s.reviews, s.fixes, repeats(v.findings, s.fixed), s.redesigned, settings.caps.maxFixRounds);
        if (action === 'finish') finish('ACCEPT');
        else if (action === 'escalate') finish(`ESCALATED: ${v.kind === 'REJECT' ? v.summary : 'fix/review cap or repeated finding after redesign'}`);
        else advance(action);
        break;
      }
      case 'redesign': {
        const v = parseVerdict(await turn('leader', `Exactly one redesign attempt is authorized, not another code review. A fixed problem has returned:
${JSON.stringify(s.findings)}
Read plan.md${architect ? ' and design.md; stay within the design, or end with VERDICT: REJECT if the design itself is the broken invariant' : ''}. Identify the broken invariant and the smallest first-principles replacement, not more guards. Update plan.md with an executable handoff for Worker on ONLY these accepted problems: exact files/functions, signatures, key logic/pseudo-code, exact regression test file/name/assertions, lint/typecheck/tests/build commands, and explicit don'ts. Leave no design judgment to Worker. Do not implement or widen scope.
End with VERDICT: FIX followed on that same line by a JSON array of at most ${settings.caps.maxFindings} findings {id,title,file,instructions,root_ids?}; instructions must contain that same concrete fix handoff. Preserve stable ids and ALL accepted inline roots (including human threads and legacy codex_root_id). Or VERDICT: REJECT <redesign blocker>.`));
        s.redesigned = true;
        if (v.kind !== 'FIX') finish(`ESCALATED: redesign blocked: ${v.summary}`);
        else { s.findings = v.findings; advance('fix'); }
        break;
      }
      case 'fix': {
        if (s.fixes >= settings.caps.maxFixRounds) { finish('ESCALATED: fix cap'); break; }
        const text = await turn('worker', `${prompt('workerFix')}\n\nExecute each finding's instructions exactly in one commit, using plan.md${s.redesigned ? ' and its explicit redesign' : ''}. Change only its named files/functions, follow the specified code shape, add its exact regression tests, run its commands, and obey its don'ts. Do not use design judgment; stop and report a blocker if instructions are ambiguous or incomplete:
${JSON.stringify(s.findings)}
Run the specified tests and configured review guidance before pushing. Push the fix commit. Reply "Fixed in <sha>" with the pushed fix commit's SHA on each accepted inline thread (Codex or human) using gh api -X POST repos/OWNER/REPO/pulls/PR/comments/ROOT_ID/replies -f body=... (use every root_ids entry plus legacy codex_root_id, deduplicated). Leader's earlier plan-forward reply is not a fixed-SHA receipt and must not suppress this reply. Inspect existing replies before posting to avoid duplicates on resume. Keep the PR non-draft, do not change its readiness, and do not post manual review requests. Do not fix declined items. End with HEAD: <full sha>.\nPR: ${s.pr}`);
        const head = headFrom(text);
        if (head === s.head) throw new Error('Fix did not produce a new commit');
        s.head = head; s.fixes++; s.fixed.push(...s.findings); s.deadline = Date.now() + 900_000;
        advance('codex'); break;
      }
    }
  }
  const cost = Object.entries(s.usage).map(([role, o]) => `${role}: ${o.tokens ? `${o.tokens} tokens` : `${o.turns} assistant turns`}`).join('; ');
  const summary = `# Loop ${key}${dry ? ' (dry run)' : ''}\n\nVerdict: ${s.verdict}\nReviews: ${s.reviews}; fix rounds: ${s.fixes}; redesigns: ${Number(s.redesigned)}\nRough cost: ${cost}\nPR: ${s.pr ?? 'none'}\n\n## Declined findings\n${s.declined.map(d => `- ${d.id}: ${d.reason}`).join('\n') || 'None'}\n`;
  writeFileSync(join(dir, 'summary.md'), summary);
  const journal = dry ? join(dir, 'events.jsonl') : eventFile;
  const id = `loop:${cwd}:${key}:${dry}`;
  if (!events(journal).some(e => e.id === id)) appendFileSync(journal, JSON.stringify({ id, issue: key,
    type: s.verdict!.startsWith('ESCALATED') ? 'loop_escalated' : 'loop_finished', time: new Date().toISOString(),
    verdict: s.verdict, pr: s.pr, summary: join(dir, 'summary.md') }) + '\n', { mode: 0o600 });
  console.log(summary);
  return s;
}
