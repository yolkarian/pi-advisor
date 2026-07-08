/**
 * Per-run and per-session advisor state plus budget enforcement.
 *
 * - A "run" is one user prompt -> one agent invocation (`before_agent_start`
 *   marks a new run). `callsThisRun` enforces `maxUsesPerRun`.
 * - A "session" spans the whole TUI session and survives across runs, so
 *   `/advisor status` can show cumulative usage.
 *
 * The state is in-memory only. Pi reloads extensions on `/reload` and session
 * switches, which naturally resets it; we do not persist counters to the session
 * file because advisor usage is observability, not conversation content.
 */

import type { AdvisorConfig } from "./config.ts";

export type AdvisorUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type RecordedCall = {
  /** Monotonic index within the session, for display. */
  index: number;
  stage: string;
  usage: AdvisorUsage;
  elapsedMs: number;
  model: string;
  truncated: boolean;
  /** First line / verdict digest, for `/advisor status` history. */
  digest: string;
};

export type AdvisorRunState = {
  runId: string;
  callsThisRun: number;
  callsThisSession: number;
  firstCallTurn: number | undefined;
  lastCallAt: number | undefined;
  /** advisor() was called at least once during this run before any mutation. */
  advisorCalledBeforeMutation: boolean;
  /** A state-changing tool call (write/edit/mutating bash) has happened this run. */
  mutationSeen: boolean;
  history: RecordedCall[];
};

function createRunState(): AdvisorRunState {
  return {
    runId: crypto.randomUUID(),
    callsThisRun: 0,
    callsThisSession: 0,
    firstCallTurn: undefined,
    lastCallAt: undefined,
    advisorCalledBeforeMutation: false,
    mutationSeen: false,
    history: [],
  };
}

export type AdvisorState = {
  /** Current run state. Replaced on each before_agent_start. */
  run: AdvisorRunState;
  /** Start a new run (called from before_agent_start). */
  startRun: () => void;
  /** The executor invoked advisor() during this run. */
  markAdvisorCalled: () => void;
  /** A state-changing tool call happened during this run. */
  markMutationSeen: () => void;
  /** Record a completed advisor call (usage + timing) for status/history. */
  recordAdvisorCall: (call: Omit<RecordedCall, "index">) => void;
  /** Whether the per-run budget is exhausted. */
  budgetExceeded: (config: AdvisorConfig) => boolean;
};

export function createAdvisorState(): AdvisorState {
  let run = createRunState();

  return {
    get run() {
      return run;
    },
    startRun() {
      run = createRunState();
    },
    markAdvisorCalled() {
      run.advisorCalledBeforeMutation = run.advisorCalledBeforeMutation || !run.mutationSeen;
    },
    markMutationSeen() {
      run.mutationSeen = true;
    },
    recordAdvisorCall(call) {
      run.callsThisRun += 1;
      run.callsThisSession += 1;
      run.lastCallAt = Date.now();
      if (run.firstCallTurn === undefined) run.firstCallTurn = run.callsThisSession;
      run.history.push({ ...call, index: run.callsThisSession });
    },
    budgetExceeded(config) {
      return run.callsThisRun >= config.maxUsesPerRun;
    },
  };
}