# pi-advisor

Advisor strategy extension for the [Pi](https://pi.dev) coding agent.

A cheap executor model owns the full coding loop — reading files, running commands,
editing code, running tests. At high-leverage moments it calls a zero-parameter
`advisor()` tool, which assembles a curated transcript of the current session,
consults a stronger advisor model, and returns concise strategic guidance as a tool
result. The advisor never edits files, runs commands, or talks to the user; it only
steers the executor.

> **low-level model owns the loop; high-level model owns sparse strategic correction.**

This implements the [advisor strategy](https://claude.com/blog/the-advisor-strategy)
as a Pi extension.

## How it works

```text
User
  ↓
Pi main loop: cheap executor model
  ↓
read / grep / bash / edit / write / test
  ↓
advisor() tool call  ← executor decides when
  ↓
extension builds curated session context (transcript, git state, failures, stage)
  ↓
high-end advisor model returns: VERDICT · WHY · NEXT_ACTIONS · RISKS · VERIFY
  ↓
tool_result flows back to the executor, which continues the loop
```

The advisor is **not** a sub-agent. It has no tools, writes no patches, and produces no
user-facing output. It returns a short structured plan, course-correction, or stop
signal. The executor treats it as guidance and verifies with its own tools.

## Install

```bash
pi install npm:pi-advisor
```

Or load locally during development:

```bash
pi -e ./index.ts
```

Then enable it (see [Commands](#commands)).

## Configuration

Config lives at `~/.pi/agent/advisor.json` (set `PI_CODING_AGENT_DIR` to override). It is
created with defaults on first use and edited via `/advisor config` or by hand.

```json
{
  "enabled": false,
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "reasoning": "xhigh",
  "maxUsesPerRun": 3,
  "maxContextMessages": 24,
  "maxAdvisorOutputTokens": 1200,
  "strictBeforeFirstWrite": false,
  "redactSecrets": true,
  "mode": "pi-ai",
  "externalCli": {
    "enabled": false,
    "command": "pi",
    "args": [],
    "resume": true
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Master switch. When off, the tool is inactive and no prompt is injected. |
| `provider` | `"openai-codex"` | Advisor model provider. |
| `model` | `"gpt-5.5"` | Advisor model id. Must be a registered model (`pi --list-models`). |
| `reasoning` | `"xhigh"` | Reasoning effort: `minimal` / `low` / `medium` / `high` / `xhigh`. Ignored for non-reasoning models. |
| `maxUsesPerRun` | `3` | Hard cap on `advisor()` calls per agent run (one user prompt = one run). |
| `maxContextMessages` | `24` | How many recent session messages to fold into the advisor context. |
| `maxAdvisorOutputTokens` | `1200` | Max output tokens for one advisor response. |
| `strictBeforeFirstWrite` | `false` | Block the first state-changing tool call until `advisor()` is called. |
| `redactSecrets` | `true` | Scrub secrets out of the advisor context before sending. |
| `mode` | `"pi-ai"` | Backend: `"pi-ai"` (reuse Pi providers/keys) or `"external-cli"` (pipe to a CLI). |
| `externalCli.command` | `"pi"` | External CLI command; must read the advisor context from stdin and write guidance to stdout. |
| `externalCli.args` | `[]` | Extra CLI args. |
| `externalCli.resume` | `true` | Hint the CLI to resume an advisor session across calls. |

## Commands

```text
/advisor                       show status
/advisor on [provider/model]   enable (and optionally set the advisor model)
/advisor off                   disable
/advisor config                show all config
/advisor config key=value      set one or more keys, e.g. /advisor config maxUsesPerRun=2 redactSecrets=true
/advisor ask                   run one advisor call now and inject the guidance into the session
```

`/advisor ask` bypasses the per-run budget (it is an explicit user action) but still
counts toward session usage. It inserts the guidance as a session message and triggers a
turn so the executor can act on it.

## The `advisor()` tool

Registered as an LLM-callable tool with **no parameters**. The extension builds the
context automatically so a cheap executor does not have to describe the problem (and
describe it badly). When enabled, the executor's system prompt gets guidance on when to
call it:

- after initial orientation (reading relevant files) and before substantive edits on
  complex tasks;
- when errors repeat, tests fail unexpectedly, or the approach may be wrong;
- before declaring a non-trivial task complete, after writing changes and running
  verification.

It is told **not** to call advisor for trivial one-line changes, before reading any
relevant files, after every small tool call, or as an implementation worker.

In the TUI, a call renders compactly and expands on demand:

```text
🧠 advisor: COURSE_CORRECT · 3 actions · 812 tokens · 4.2s
```

## Stage detection

Each call classifies the executor state into one of four stages, read deterministically
from the session branch:

| Stage | When | Advisor focus |
|-------|------|---------------|
| `initial` | orientation done, no mutations yet | right entry point, what to read, strategy |
| `implementation` | edits started, no repeated failures | patch direction, test coverage, design risks |
| `recovery` | repeated failures, executor may be stuck | root cause, smaller repro, revert or pivot |
| `final-check` | mutations + verification after the last mutation | missed tests, unmet requirements, ready to finalize |

The stage is shown in `/advisor status` history and in the expanded tool result.

## Context building

The advisor receives a structured, curated context — never the raw transcript:

```text
<task>            original user goal + latest steering
<executor_state>  model, thinking level, cwd, active tools, stage, call count
<project_signals> git status, git diff --stat, recent failures
<recent_transcript> first user task + last N messages with truncated tool results
<constraints>     AGENTS.md / SYSTEM.md excerpt
```

Tool results are truncated (head+tail for failures, middle-truncated otherwise), secret
files are summarized by path/key-name only, and prior advisor guidance is kept short so
the advisor does not repeat itself.

## Backends

### `pi-ai` (default)

Reuses Pi's provider/model registry and API key management. Set `provider`/`model` to any
registered model and make sure auth is configured (`/login` or `auth.json`). Calls use a
single non-streaming completion with no tools.

### `external-cli`

For users who want the advisor to be a separate process — for example another `pi` invocation, or any CLI that reads a prompt from stdin and writes guidance to stdout — without configuring a second API key in Pi. The extension pipes the curated context to the command's stdin and parses stdout as the advisor guidance. Usage stats are not available from the CLI, so token counts report as zero.

```json
{
  "mode": "external-cli",
  "externalCli": { "enabled": true, "command": "pi", "args": [], "resume": true }
}
```

Note: the command must consume the advisor context from stdin and emit guidance on stdout. `pi` does not do this with empty args, so configure `args` (or a wrapper) accordingly, or use the default `pi-ai` backend.

## Security & privacy

- `redactSecrets` is on by default and scrubs common token shapes, PEM blocks, bearer
  headers, and `key=value`-style secrets before anything is sent to the advisor.
- Secret files (`.env`, `*.pem`, `*.key`, `credentials.json`, …) are never sent verbatim;
  only a path + key-name summary is included.
- The advisor has no tools and cannot edit files or run commands.

Redaction is defense-in-depth, not a security boundary. Review the advisor model/provider
policy before sending proprietary code.

## Failure behavior

Advisor failures never interrupt the main agent loop. On error, the executor receives a
short notice such as `Advisor call failed: <reason>. Continue with local evidence and
verification.` and proceeds on its own. Budget exhaustion returns
`Advisor budget exceeded for this run. Continue without advisor.`

## Compatibility

Built and tested against Pi `0.80.x` (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `typebox`).

## Project layout

```text
index.ts            entry point: wires config, state, command, events, tool, renderer
src/
  tool.ts          the advisor() tool + shared advisor-call core (runAdvisorCall)
  commands.ts      /advisor command and subcommands
  config.ts        load/save/validate ~/.pi/agent/advisor.json
  state.ts         per-run + per-session state and budget enforcement
  prompt.ts        executor guidance + advisor system prompt
  stage.ts         branch analysis + stage detection (shared with transcript)
  redaction.ts     secret scrubbing + secret-file summarization
  transcript.ts    curated advisor context builder
  render.ts        compact/expanded TUI rendering for the advisor tool
  adapter/
    types.ts       shared AdvisorResponse type
    pi-ai.ts       pi-ai backend (completeSimple, no tools)
    external-cli.ts external CLI backend (spawn + stdin/stdout)
```

## License

MIT