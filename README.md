<p align="center"><img src="https://raw.githubusercontent.com/logancyang/pi-piper/main/assets/banner.jpg" alt="pi-piper: you text from a hammock while a little robot crew marches out to build" width="100%"></p>

# pi-piper

> A quiet line between intent and work.

pi-piper is a small durable runner for always-on Pi coding agents. It gives a bot a durable inbox, independent jobs, and a bounded leader/worker loop for GitHub issues.

An always-on bot such as Grok Bot, Dots, Muse, or Hermes Agent can run on its own cloud computer. Talk to it from your phone like a chief of staff; it can delegate work and report back while you are away.

```text
phone ↔ bot ↔ pi-piper
                 ├─ architect job: design (optional)
                 ├─ leader job: plan / review
                 └─ worker job: implement / fix
```

The leader plans and reviews; the faster worker implements. An optional architect goes first: it reads the issue and code and writes a short design doc the leader must follow; it never writes code. Without an architect, the leader also designs. Astra/Luna, Opus/Sonnet, and Fable/Haiku are example pairings, not requirements; Opus can serve as both architect and leader with Sonnet as worker. Choose models supported by your Pi login.

## Install

Requires Node 22.19+ and Pi signed in with `pi /login`.

```sh
npm install -g @logancyang/pi-piper
pi-piper daemon start
```

From a checkout, for development:

```sh
git clone https://github.com/logancyang/pi-piper.git && cd pi-piper
npm install              # also builds dist/
npm link
```

## In a minute

```sh
pi-piper daemon start
pi-piper start inbox --cwd /path/to/repo --prompt 'Inspect the project and report its state'
pi-piper watch --timeout 60
pi-piper loop https://github.com/acme/widgets/issues/42 --cwd /path/to/linked-worktree \
  --leader anthropic/claude-opus --worker anthropic/claude-sonnet
```

`pi-piper start` supports `--prompt` or `--prompt-file`; `send`, `status`, `tail`, `wait`, `cancel`, `pending`, and `ack` operate on jobs and notifications. `pi-piper wait-loop ISSUE` waits for a loop's terminal event.

## Bot supervisor protocol

1. Run `pi-piper watch` in the background and wake when it returns.
2. On wake, answer or relay every `NEEDS_INPUT` event; report pull requests and finished jobs.
3. Handle each event before acknowledging it.
4. Run `pi-piper ack EVENT_ID ...` for events handled.
5. Re-run `pi-piper watch`; use `pi-piper pending` to inspect unacknowledged events.

Every job turn ends with exactly one final line: `STATUS: DONE`, `STATUS: NEEDS_INPUT: <question>`, or `STATUS: BLOCKED: <reason>`. Missing or malformed status is not success. Watch delivery is at-least-once, so make external actions safe to repeat.

## Issue loop and config

```sh
pi-piper loop <issue-url> --cwd DIR --leader <model> --worker <model> \
  [--leader-thinking LEVEL] [--worker-thinking LEVEL] [--architect <model>] [--architect-thinking LEVEL] \
  [--architect-identity FILE] [--prompts DIR] [--dry-run]
```

An optional `piper.config.json` sets role models/thinking, prompt files, and caps. CLI flags override role settings; `--prompts DIR` selects the prompt directory. For example:

```json
{
  "roles": {
    "architect": { "model": "provider/strong", "thinking": "high" },
    "leader": { "model": "provider/strong", "thinking": "high" },
    "worker": { "model": "provider/fast", "thinking": "medium" }
  },
  "prompts": {
    "leaderPlan": "leader-plan.md",
    "leaderReview": "leader-review.md",
    "workerImplement": "worker-implement.md",
    "workerFix": "worker-fix.md",
    "triage": "triage.md",
    "reviewGuidance": "~/.config/pi-piper/review.md",
    "prDescription": "~/.config/pi-piper/pr.md",
    "architectDesign": "architect-design.md",
    "architectIdentity": "~/.config/pi-piper/architect.md"
  },
  "caps": { "maxFixRounds": 2, "maxFindings": 5, "sizeBudget": 400 }
}
```

Prompt names resolve relative to the prompt directory; absolute paths are accepted. Optional review, PR-description, and architect identity files plug in user-specific practice; the identity file is prepended to the architect prompt. Architect thinking and prompts require an architect model. The built-in triage fallback is short and generic.

The loop designs (when an architect is set) into `.piper-loop/<issue>/design.md`, plans, implements, opens a ready PR, triages each new review comment with a leader reply, and lets the worker reply `Fixed in <sha>` after fixes. Automatic review bots can run on open and push. It never merges. `--dry-run` exercises the loop without models or GitHub.

## Guarantees and limits

Job submissions are durably admitted and resumable; notifications have stable IDs and explicit acknowledgements. State defaults to `~/.pi-piper`, or `$PIPER_HOME` when set. The SQLite database is authoritative; logs and event records are local state.

This is trusted local automation, not a sandbox. Shell side effects are not exactly-once, and a shell child can outlive a killed process. Model instructions are not a security boundary. Pi Durable by Earendil is experimental; treat state and recovery behavior accordingly. No merge, no claim of exactly-once external effects.

## License

MIT. See [LICENSE](LICENSE).
