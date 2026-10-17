export const statusInstruction = `Make reasonable decisions yourself. Ask only for things you cannot decide, such as scope, approvals, publishing, or money.
End every completed turn with exactly one final status line, after any task-specific output:
STATUS: DONE
STATUS: NEEDS_INPUT: <question>
STATUS: BLOCKED: <reason>
Choose exactly one. Use DONE only when the requested work is complete; include a concrete question or reason otherwise.`;

export type TurnStatus = { type: 'done' } | { type: 'needs_input'; question: string } | { type: 'blocked'; reason: string };
export function turnStatus(message: string): TurnStatus {
  const last = message.trimEnd().split('\n').at(-1);
  if (last === 'STATUS: DONE') return { type: 'done' };
  const match = /^STATUS: (NEEDS_INPUT|BLOCKED): (\S.*)$/.exec(last ?? '');
  if (match) return match[1] === 'NEEDS_INPUT'
    ? { type: 'needs_input', question: match[2].trimEnd() }
    : { type: 'blocked', reason: match[2].trimEnd() };
  return { type: 'needs_input', question: message || 'Job ended without an assistant message.' };
}
