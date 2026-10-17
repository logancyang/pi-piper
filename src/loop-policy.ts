export type Finding = { id: string; title: string; file: string; instructions: string; root_ids?: number[]; codex_root_id?: number };
export type Declined = { id: string; reason: string };
export type Verdict = { kind: 'ACCEPT' | 'FIX' | 'REJECT' | 'SPLIT'; findings: Finding[]; summary: string; declined: Declined[] };
export function parseVerdict(text: string, maxFindings = 5): Verdict {
  const line = text.trim().split('\n').at(-1)!;
  const match = /^VERDICT: (ACCEPT|FIX|REJECT|SPLIT)(?: (.+))?$/.exec(line);
  if (!match) throw new Error('Missing final VERDICT line');
  const kind = match[1] as Verdict['kind'];
  const findings = kind === 'FIX' ? JSON.parse(match[2] ?? 'null') : [];
  const validRoot = (id: unknown) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  if (!Array.isArray(findings) || (kind === 'FIX' && (!findings.length || findings.length > maxFindings)) || findings.some(f =>
    !f || typeof f.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(f.id) || typeof f.title !== 'string' || !f.title.trim() ||
    typeof f.file !== 'string' || !f.file.trim() || typeof f.instructions !== 'string' || !f.instructions.trim() ||
    (f.root_ids !== undefined && (!Array.isArray(f.root_ids) || !f.root_ids.length || !f.root_ids.every(validRoot) || new Set(f.root_ids).size !== f.root_ids.length)) ||
    (f.codex_root_id !== undefined && !validRoot(f.codex_root_id))) ||
    new Set(findings.map(f => f.id)).size !== findings.length) throw new Error(`Invalid findings (1–${maxFindings} unique short ids and concrete instructions required)`);
  if (kind === 'ACCEPT' && match[2]) throw new Error('ACCEPT takes no payload');
  if (kind === 'REJECT' && !match[2]) throw new Error('REJECT needs a redesign summary');
  const ledger = text.split('\n').find(l => l.startsWith('DECLINED: '));
  const declined = ledger ? JSON.parse(ledger.slice(10)) : [];
  if (!Array.isArray(declined) || declined.some(d => !d || typeof d.id !== 'string' || typeof d.reason !== 'string' || !d.reason.trim()))
    throw new Error('Invalid declined ledger');
  return { kind, findings, summary: match[2] ?? '', declined };
}
const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const repeats = (current: Finding[], fixed: Finding[]) => current.some(f => fixed.some(old =>
  old.id === f.id || (normalized(old.file) === normalized(f.file) && normalized(old.title) === normalized(f.title))));
export function nextAction(v: Verdict, reviews: number, fixes: number, repeated: boolean, redesigned: boolean, maxFixRounds = 2) {
  if (v.kind === 'ACCEPT') return 'finish';
  if (v.kind !== 'FIX' || fixes >= maxFixRounds || reviews >= maxFixRounds + 1 || (repeated && redesigned)) return 'escalate';
  return repeated ? 'redesign' : 'fix';
}
export function issueKey(url: string) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url);
  if (!m) throw new Error('Expected https://github.com/OWNER/REPO/issues/NUMBER');
  return `${m[1]}-${m[2]}-${m[3]}`;
}
