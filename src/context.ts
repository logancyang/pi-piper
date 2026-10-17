import { homedir } from 'node:os';
import { join } from 'node:path';
import { statusInstruction } from './supervision.js';
import {
  DefaultResourceLoader, SettingsManager,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
} from '@earendil-works/pi-coding-agent';
// Not a public subpath export in 1.3.0. Keep the package pinned; do not duplicate Pi's prompt.
import { buildSystemPrompt } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';

export async function codingPrompt(cwd: string): Promise<string> {
  const loader = new DefaultResourceLoader({
    cwd, agentDir: join(homedir(), '.pi/agent'),
    // Discover context/skills without executing extensions or installing configured packages.
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noThemes: true, noPromptTemplates: true,
    additionalSkillPaths: [join(homedir(), '.agents/skills')],
  });
  await loader.reload();
  const tools = [createReadToolDefinition(cwd), createWriteToolDefinition(cwd),
    createEditToolDefinition(cwd), createBashToolDefinition(cwd)];
  return buildSystemPrompt({
    cwd, selectedTools: tools.map(t => t.name),
    toolSnippets: Object.fromEntries(tools.map(t => [t.name, t.promptSnippet ?? ''])),
    toolGuidelines: Object.fromEntries(tools.map(t => [t.name, t.promptGuidelines ?? []])),
    contextFiles: loader.getAgentsFiles().agentsFiles,
    skills: loader.getSkills().skills,
    appendSystemPrompt: [...loader.getAppendSystemPrompt(), statusInstruction].join('\n\n'),
  });
}
