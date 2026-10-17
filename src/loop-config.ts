import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Role = 'leader' | 'worker';
export type LoopOptions = {
  models: Record<Role, string>;
  thinking: Record<Role, string>;
  promptDir: string;
  promptFiles: Record<'leaderPlan' | 'leaderReview' | 'workerImplement' | 'workerFix' | 'triage' | 'reviewGuidance' | 'prDescription', string>;
  caps: { maxFixRounds: number; maxFindings: number; sizeBudget: number };
};
const defaults: LoopOptions = {
  models: { leader: 'openai/gpt-4.1', worker: 'openai/gpt-4.1-mini' },
  thinking: { leader: 'high', worker: 'high' },
  promptDir: fileURLToPath(new URL('../prompts/', import.meta.url)),
  promptFiles: { leaderPlan: 'leader-plan.md', leaderReview: 'leader-review.md', workerImplement: 'worker-implement.md', workerFix: 'worker-fix.md', triage: 'triage.md', reviewGuidance: '', prDescription: '' },
  caps: { maxFixRounds: 2, maxFindings: 5, sizeBudget: 400 },
};
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid piper.config.json object');
  return value as Record<string, any>;
}
function positive(value: unknown, name: string, max = 100_000, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > max) throw new Error(`Invalid config cap: ${name}`);
  return value as number;
}
export function loadLoopOptions(cwd: string, overrides: Partial<{ models: Partial<Record<Role, string>>; thinking: Partial<Record<Role, string>>; promptDir: string }> = {}): LoopOptions {
  const file = resolve(cwd, 'piper.config.json');
  const raw = existsSync(file) ? object(JSON.parse(readFileSync(file, 'utf8'))) : {};
  const roles = raw.roles === undefined ? {} : object(raw.roles);
  const configuredModels = raw.models === undefined ? {} : object(raw.models);
  const configuredThinking = raw.thinking === undefined ? {} : object(raw.thinking);
  const roleValue = (role: Role, key: string) => roles[role] === undefined ? undefined : object(roles[role])[key];
  const models = { ...defaults.models };
  const thinking = { ...defaults.thinking };
  for (const role of ['leader', 'worker'] as const) {
    models[role] = overrides.models?.[role] ?? roleValue(role, 'model') ?? configuredModels[role] ?? models[role];
    thinking[role] = overrides.thinking?.[role] ?? roleValue(role, 'thinking') ?? configuredThinking[role] ?? thinking[role];
    if (typeof models[role] !== 'string' || !models[role] || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking[role])) throw new Error(`Invalid ${role} role config`);
  }
  const configuredPrompts = raw.prompts === undefined ? {} : object(raw.prompts);
  const promptFiles = { ...defaults.promptFiles };
  for (const key of Object.keys(promptFiles) as (keyof typeof promptFiles)[]) {
    const value = configuredPrompts[key];
    if (value !== undefined && typeof value !== 'string') throw new Error(`Invalid prompt config: ${key}`);
    if (value !== undefined) promptFiles[key] = value;
  }
  const configuredCaps = raw.caps === undefined ? {} : object(raw.caps);
  const caps = {
    maxFixRounds: configuredCaps.maxFixRounds === undefined ? defaults.caps.maxFixRounds : positive(configuredCaps.maxFixRounds, 'maxFixRounds', 20, 0),
    maxFindings: configuredCaps.maxFindings === undefined ? defaults.caps.maxFindings : positive(configuredCaps.maxFindings, 'maxFindings', 20),
    sizeBudget: configuredCaps.sizeBudget === undefined ? defaults.caps.sizeBudget : positive(configuredCaps.sizeBudget, 'sizeBudget'),
  };
  const configuredPromptDir = raw.promptDir ?? defaults.promptDir;
  if (typeof configuredPromptDir !== 'string') throw new Error('Invalid config promptDir');
  const selectedPromptDir = overrides.promptDir ?? configuredPromptDir;
  const promptDir = isAbsolute(selectedPromptDir) ? selectedPromptDir : resolve(cwd, selectedPromptDir);
  return { models, thinking, promptDir, promptFiles, caps };
}
export function promptPath(options: LoopOptions, key: keyof LoopOptions['promptFiles']) {
  const file = options.promptFiles[key];
  if (!file) return '';
  const expanded = file.startsWith('~/') ? resolve(homedir(), file.slice(2)) : file;
  return isAbsolute(expanded) ? expanded : resolve(options.promptDir, expanded);
}
