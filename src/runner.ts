import { appendFileSync, existsSync, readFileSync, truncateSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  Harness, configure, createRegistry, defineDoc, defineExtension, section, watchEvents,
  type ConversationId, type SubmissionRecord, type EntryRecord, type AgentEvent,
  type AgentEventStream, type ModelRef, type SubmissionId,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codingPrompt } from './context.js';
import { turnStatus } from './supervision.js';

export const home = process.env.PIPER_HOME ? join(process.env.PIPER_HOME) : join(homedir(), '.pi-piper');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Job = { key: string; conversationId: ConversationId; cwd: string; createdAt: number };
export type JobEvent = {
  id: string; type: 'pr_opened' | 'done' | 'needs_input' | 'blocked' | 'failed' | 'settled'; job: string;
  sequence?: number; // Absent only in pre-supervision outboxes.
  time: string; conversationId: ConversationId; submissionId?: SubmissionId; requestId?: string;
  url?: string; reason?: string; question?: string;
};
const Jobs = defineDoc<{ jobs: Record<string, Job> }>({
  kind: 'piper.jobs', version: 1, scope: 'session', initial: () => ({ jobs: {} }),
});
const Outbox = defineDoc<{ events: Record<string, JobEvent>; acked?: Record<string, true>; legacyImported?: boolean }>({
  kind: 'piper.events', version: 1, scope: 'session', initial: () => ({ events: {} }),
});
export function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
function entryText(e: EntryRecord) {
  return (e.model ?? []).filter(m => m.role === 'assistant').map(m => text(m.content)).join('\n');
}
const prPattern = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+\b/g;

export class Runner {
  private constructor(readonly harness: Harness, private storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>,
    private models: ModelRuntime) {}
  readonly notifications = new EventEmitter();
  private streams = new Map<string, Promise<AgentEventStream>>();
  private activity = new Map<string, number>();
  private logged = new Set<string>();
  private eventFile = join(home, 'events.jsonl');

  static async open() {
    // The same file-backed CredentialStore and pi-ai OAuth resolve/refresh path as the CLI.
    // Never extract tokens, pass them to tools, or serialize auth/error objects.
    const models = await ModelRuntime.create({ authPath: join(homedir(), '.pi/agent/auth.json'),
      refreshOnCreate: false });
    const registry = createRegistry();
    registry.install(CodingTools);
    const prompts = new Map<string, Promise<string>>();
    registry.install(defineExtension({ name: 'piper.context', sections: [section('pi', ({ agent }) => {
      const cwd = agent.cwd!;
      if (!prompts.has(cwd)) prompts.set(cwd, codingPrompt(cwd));
      return prompts.get(cwd)!;
    }, { tag: false })] }));
    const storage = await openNodeSqliteStorage(join(home, 'state.db'));
    const harness = await Harness.open(storage, {
      models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd! }),
      settings: { followUpMode: 'one-at-a-time', stream: { timeoutMs: 300_000 } },
      onReport: () => console.error('Harness reported a background error (details suppressed for credential safety).'),
    }, ctx);
    const runner = new Runner(harness, storage, models);
    await runner.recover();
    return runner;
  }

  async recover() {
    await this.harness.commit(async tx => {
      await tx.doc(Jobs);
      const doc = await tx.doc(Outbox);
      doc.acked ??= {};
      Object.values(doc.events).forEach((event, i) => { event.sequence ??= i + 1; });
      doc.legacyImported = true;
    }, ctx);
    this.readJournal();
    for (const event of Object.values((await this.harness.snapshot(Outbox, ctx))!.events)) this.publish(event);
    for (const job of await this.jobs()) await this.attach(job);
    const pending = await this.harness.inspect(ctx);
    console.log(`${new Date().toISOString()} recovery: ${pending.tasks.length} tasks, ${pending.submissions.length} submissions`);
    // Restore watchers before scheduling, so recovery events cannot fall through a startup gap.
    this.harness.resume();
    for (const task of pending.tasks) {
      if (task.state.kind !== 'blocked') void this.harness.waitForTask(task.record.id, ctx).catch(() => {});
    }
  }

  private readJournal() {
    if (!existsSync(this.eventFile)) return;
    const buf = readFileSync(this.eventFile);
    const end = buf.lastIndexOf(10) + 1;
    // A SIGKILL during append can leave a partial last line. The durable outbox repairs it.
    if (end < buf.length) truncateSync(this.eventFile, end);
    for (const line of buf.subarray(0, end).toString().split('\n').filter(Boolean)) {
      this.logged.add(JSON.parse(line).id);
    }
  }
  private publish(event: JobEvent) {
    if (!this.logged.has(event.id)) {
      appendFileSync(this.eventFile, JSON.stringify(event) + '\n', { mode: 0o600 });
      this.logged.add(event.id);
    }
    this.notifications.emit('event', event);
  }
  private async emit(job: Job, type: JobEvent['type'], key: string | number, extra: Partial<JobEvent> = {}) {
    // Preserve the old settled receipt ID across classification and legacy-ledger import.
    const identity = ['done', 'needs_input', 'blocked'].includes(type) ? 'settled' : type;
    const id = hash(JSON.stringify([job.key, identity, key]));
    const event = await this.harness.commit(async tx => {
      const doc = await tx.doc(Outbox);
      const previous = doc.events[id];
      if (previous && previous.type !== 'settled') return undefined;
      const value: JobEvent = { ...(previous ?? { id, job: job.key, conversationId: job.conversationId,
        time: new Date().toISOString(), sequence: Object.keys(doc.events).length + 1 }), type, ...extra };
      doc.events[id] = value;
      return value;
    }, ctx);
    if (event) this.publish(event);
  }
  private async findPR(job: Job, value: string, complete = true) {
    for (const match of value.matchAll(prPattern)) {
      // A streamed chunk can stop halfway through the PR number. Wait for a delimiter or final entry.
      if (!complete && match.index + match[0].length === value.length) continue;
      await this.emit(job, 'pr_opened', match[0], { url: match[0] });
    }
  }
  private async scanEntry(job: Job, entry: EntryRecord) {
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant' || (message.role === 'toolResult' && message.toolName === 'bash')) {
        await this.findPR(job, text(message.content));
      }
    }
  }
  private async submissionEvent(job: Job, record: SubmissionRecord) {
    if (record.type !== 'input' || !['done', 'unanswered'].includes(record.status)) return;
    const status = record.status === 'done'
      ? turnStatus(entryText((await this.storage.entry(record.answer, ctx))!.entry))
      : { type: 'failed' as const, reason: record.reason };
    await this.emit(job, status.type, record.id, {
      ...status, submissionId: record.id, ...(record.requestId ? { requestId: record.requestId } : {}),
    });
  }
  private attach(job: Job) {
    let attached = this.streams.get(job.key);
    if (attached) return attached;
    attached = (async () => {
      const stream = await watchEvents(this.harness, job.conversationId, ctx);
      let assistant = '';
      const outputs = new Map<string, string>();
      const snapshot = async (s: typeof stream.snapshot) => {
        for (const entry of s.entries) await this.scanEntry(job, entry);
        // A coalesced snapshot can replace submission events. Reconcile from durable receipts.
        let cursor;
        do {
          const page = await this.storage.scanSubmissions({ conversationId: job.conversationId }, 200, cursor, ctx);
          for (const record of page.items) await this.submissionEvent(job, record);
          cursor = page.next;
        } while (cursor);
        assistant = text(s.generation?.message?.content);
        await this.findPR(job, assistant, false);
        for (const tool of s.tools) {
          if (tool.name === 'bash') {
            outputs.set(tool.callId, tool.output ?? '');
            await this.findPR(job, tool.output ?? '', false);
          }
        }
      };
      await snapshot(stream.snapshot);
      stream.start(async (events: readonly AgentEvent[]) => {
        this.activity.set(job.key, Date.now());
        for (const event of events) {
          switch (event.type) {
            case 'snapshot': await snapshot(event); break;
            case 'message_start': assistant = ''; break;
            case 'message_update':
              for (const change of event.changes) {
                if (change.type === 'text_delta') assistant += change.delta;
                if (change.type === 'message') assistant = text(change.message.content);
                if (change.type === 'block' && change.block.type === 'text') assistant += change.block.text;
              }
              await this.findPR(job, assistant, false); break;
            case 'message_end': case 'entry_appended': await this.scanEntry(job, event.entry); break;
            case 'tool_execution_update':
              if (event.toolName === 'bash' && event.output) {
                const o = event.output;
                const value = 'set' in o ? o.set : (outputs.get(event.toolCallId) ?? '').slice(o.trimStart ?? 0) + (o.append ?? '');
                outputs.set(event.toolCallId, value);
                await this.findPR(job, value, false);
              }
              break;
            case 'tool_execution_end':
              outputs.delete(event.toolCallId);
              if (event.entry) await this.scanEntry(job, event.entry);
              break;
            case 'submission': await this.submissionEvent(job, event.record); break;
          }
        }
      });
      return stream;
    })();
    this.streams.set(job.key, attached);
    return attached;
  }
  async jobs(): Promise<Job[]> { return Object.values((await this.harness.snapshot(Jobs, ctx))!.jobs); }
  async job(key: string): Promise<Job> {
    const found = (await this.harness.snapshot(Jobs, ctx))!.jobs[hash(key)];
    if (!found) throw new Error(`Unknown job: ${key}`);
    return found;
  }
  async start(key: string, cwd: string, model: string, thinking: string) {
    const at = model.indexOf('/');
    const ref: ModelRef = at < 0 ? { provider: 'openai', modelId: model } : { provider: model.slice(0, at), modelId: model.slice(at + 1) };
    if (!this.models.getModel(ref.provider, ref.modelId)) throw new Error(`Unknown model: ${model}`);
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
    const job = await this.harness.commit(async tx => {
      const doc = await tx.doc(Jobs);
      const existing = doc.jobs[hash(key)];
      if (existing) {
        if (existing.cwd !== cwd) throw new Error('Job already exists with a different cwd');
        return { ...existing };
      }
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, conversation.id, { cwd, model: ref, thinkingLevel: thinking as ModelThinkingLevel });
      const value = { key, cwd, conversationId: conversation.id, createdAt: Date.now() };
      doc.jobs[hash(key)] = value;
      return value;
    }, ctx);
    await this.attach(job);
    return job;
  }
  async submit(job: Job, prompt: string, requestId: string) {
    const conversation = (await this.harness.conversation(job.conversationId, ctx))!;
    const submission = await conversation.submit({ type: 'input', content: prompt, requestId, whenBusy: 'followUp' }, ctx);
    this.activity.set(job.key, Date.now());
    return { job: job.key, conversationId: job.conversationId, requestId, submissionId: submission.id,
      status: (await submission.status(ctx)).status };
  }
  async cancel(job: Job) {
    const conversation = (await this.harness.conversation(job.conversationId, ctx))!;
    // Pi atomically withdraws queued inputs and persists abort marks before signalling running work.
    await conversation.abort(ctx, { background: true });
    this.activity.set(job.key, Date.now());
    return { job: job.key, status: 'cancelled' };
  }
  async status(job: Job) {
    const c = (await this.harness.conversation(job.conversationId, ctx))!;
    const watch = await c.watch(ctx);
    const v = watch.value;
    await watch.stop();
    const live = v.docs['pi.live'] as { run?: unknown } | undefined;
    const queued = (v.docs['pi.inbox'] as { items?: unknown[] } | undefined)?.items?.length ?? 0;
    const entries = await c.entries({ order: 'descending' }, 100, undefined, ctx);
    const assistant = entries.items.map(entryText).find(Boolean) ?? '';
    const times = entries.items.flatMap(e => (e.model ?? []).map(m => m.timestamp));
    return { job: job.key, conversationId: job.conversationId, cwd: job.cwd,
      status: live?.run ? 'running' : queued ? 'queued' : 'idle', queued,
      lastActivity: new Date(Math.max(job.createdAt, this.activity.get(job.key) ?? 0, ...times)).toISOString(),
      lastAssistant: assistant.slice(-300) };
  }
  async tail(job: Job, n: number) {
    const c = (await this.harness.conversation(job.conversationId, ctx))!;
    const page = await c.entries({ order: 'descending' }, n, undefined, ctx);
    return [...page.items].reverse().flatMap(e => (e.model ?? []).flatMap(m => {
      if (m.role === 'system') return [];
      const lines = [`[${m.role}${m.role === 'toolResult' ? ':' + m.toolName : ''}] ${text(m.content).slice(0, m.role === 'toolResult' ? 500 : 4000)}`];
      if (m.role === 'assistant') for (const b of m.content) if (b.type === 'toolCall') lines.push(`  tool ${b.name} ${JSON.stringify(b.arguments).slice(0, 500)}`);
      return lines;
    })).join('\n');
  }
  // Read-only, untruncated result/usage for the deterministic loop (tail remains unchanged).
  async output(job: Job) {
    const c = (await this.harness.conversation(job.conversationId, ctx))!;
    let cursor, result = '', turns = 0, tokens = 0;
    do {
      const page = await c.entries({ order: 'descending' }, 200, cursor, ctx);
      for (const entry of page.items) {
        if (!result) result = entryText(entry);
        for (const m of entry.model ?? []) if (m.role === 'assistant') {
          turns++;
          tokens += m.usage?.totalTokens ?? 0;
        }
      }
      cursor = page.next;
    } while (cursor);
    return { text: result, turns, ...(tokens ? { tokens } : {}) };
  }
  async latestSubmission(job: Job) {
    return (await this.storage.scanSubmissions({ conversationId: job.conversationId, order: 'descending' }, 1, undefined, ctx)).items[0]?.id;
  }
  // Register the caller's listener BEFORE this read. No DB polling or read/subscribe gap.
  async matchingEvent(job: Job, until: string, target: SubmissionId | undefined): Promise<JobEvent | undefined> {
    const events = Object.values((await this.harness.snapshot(Outbox, ctx))!.events).filter(e => e.job === job.key);
    const pr = events.find(e => e.type === 'pr_opened');
    if (until === 'pr' || (until === 'any' && pr)) return pr;
    return events.find(e => e.submissionId === target);
  }
  async pending(since?: string): Promise<JobEvent[]> {
    const doc = (await this.harness.snapshot(Outbox, ctx))!;
    if (since !== undefined && !Object.hasOwn(doc.events, since)) throw new Error('Invalid event cursor');
    const after = since === undefined ? 0 : doc.events[since].sequence!;
    const jobs = new Map((await this.jobs()).map(job => [job.key, job]));
    return Object.values(doc.events).filter(event => {
      const cwd = jobs.get(event.job)?.cwd;
      return event.sequence! > after && !doc.acked?.[event.id] && cwd && cwd !== '/tmp' && !cwd.startsWith('/tmp/');
    }).sort((a, b) => a.sequence! - b.sequence!);
  }
  async ack(ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid event IDs');
    await this.harness.commit(async tx => {
      const doc = await tx.doc(Outbox);
      doc.acked ??= {};
      for (const id of ids) doc.acked[id] = true;
    }, ctx);
    return { acked: ids };
  }
  async watch(since?: string, timeout?: number, signal?: AbortSignal): Promise<JobEvent[] | { type: 'timeout' }> {
    // Watch the existing durable outbox directly. Coalesced notifications are only wakeups.
    const watch = (await this.harness.watchDoc(Outbox, ctx))!;
    try {
      const existing = await this.pending(since);
      if (existing.length) return existing;
      if (signal?.aborted) return [];
      return await new Promise((resolve, reject) => {
        let finished = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (value: JobEvent[] | { type: 'timeout' }, error?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish([]);
        signal?.addEventListener('abort', abort, { once: true });
        watch.start(async () => {
          try { const events = await this.pending(since); if (events.length) finish(events); }
          catch (error) { finish([], error); }
        });
        if (timeout !== undefined) timer = setTimeout(() => finish({ type: 'timeout' }), timeout * 1000);
        void watch.closed.then(() => finish([], new Error('Outbox watch closed; restart watch')));
      });
    } finally { await watch.stop(); }
  }
  async close() {
    for (const stream of this.streams.values()) await (await stream).stop();
    await this.harness.close(ctx);
  }
}
