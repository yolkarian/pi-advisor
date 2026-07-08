/**
 * Stage detection for advisor calls.
 *
 * The advisor's value depends on when it is called. We classify the current executor
 * state into one of four stages by scanning the session branch, so the advisor system
 * prompt can be tuned and `/advisor status` can report what happened.
 *
 *   initial       - orientation done (reads/greps), no mutations yet
 *   implementation - edits started, no repeated failures
 *   recovery      - repeated failures, executor may be stuck
 *   final-check   - mutations + verification done, near a final answer
 *
 * Detection is deterministic and heuristic-only; it never blocks tool calls.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AdvisorState } from "./state.ts";

export type AdvisorStage = "initial" | "implementation" | "recovery" | "final-check";

/** Bash commands that mutate the working tree or install/alter dependencies. */
const STATE_CHANGING_BASH =
  /\b(?:rm|mv|cp|mkdir|rmdir|chmod|chown|ln|touch|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|clean|stash|cherry-pick)|npm\s+(?:install|i|uninstall|ci|run\s+build)|pnpm\s+(?:install|add|remove|ci)|yarn\s+(?:install|add|remove)|pip\s+install|pip3\s+install|uv\s+(?:add|install|pip\s+install)|cargo\s+(?:add|install|build|run)|go\s+(?:install|build|run)|make\s+(?:install|all)|brew\s+(?:install|uninstall)|apt(?:-get)?\s+(?:install|remove|purge)|docker\s+(?:build|run|exec))\b/;

/** Bash commands that look like verification (tests, type checks, lints, builds). */
const VERIFICATION_BASH =
  /\b(?:pytest|py\.test|unittest|nox|tox|jest|vitest|mocha|ava|karma|test|ruff|mypy|pyright|pylint|flake8|tsc|typescript|eslint|biome|prettier|deno\s+test|bun\s+test|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|rustc|mvn|gradle|gradlew|check|build|lint|verify)\b/;

export type BranchSignals = {
  mutationSeen: boolean;
  failureCount: number;
  verificationSeen: boolean;
  lastMutationIndex: number;
  lastVerificationIndex: number;
  /** Recent failing commands/tests (most recent first), capped for the transcript. */
  recentFailures: Array<{ command: string; output: string }>;
};

/** Extract plain text from an LLM message content array (or string). */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const p = part as { type: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") return p.text;
      }
      return "";
    })
    .join("");
}

/** Best-effort command string from a bash tool call's arguments. */
function bashCommandFromArgs(args: unknown): string {
  if (args && typeof args === "object" && "command" in args) {
    const cmd = (args as { command?: unknown }).command;
    if (typeof cmd === "string") return cmd;
  }
  return "";
}

/** Returns true when a tool name + args describe a state-changing action. */
export function isStateChangingToolCall(toolName: string, args: unknown): boolean {
  if (toolName === "write" || toolName === "edit") return true;
  if (toolName === "bash") {
    const cmd = bashCommandFromArgs(args);
    return STATE_CHANGING_BASH.test(cmd);
  }
  return false;
}

/** Returns true when a tool name + args describe a verification action. */
export function isVerificationToolCall(toolName: string, args: unknown): boolean {
  if (toolName === "bash") {
    const cmd = bashCommandFromArgs(args);
    return VERIFICATION_BASH.test(cmd);
  }
  return false;
}

const MAX_RECENT_FAILURES = 4;

/**
 * Scan a session branch (entries from `sessionManager.getBranch()`) and summarize
 * the signals stage detection and transcript building both need.
 */
export function analyzeBranch(branch: SessionEntry[]): BranchSignals {
  const signals: BranchSignals = {
    mutationSeen: false,
    failureCount: 0,
    verificationSeen: false,
    lastMutationIndex: -1,
    lastVerificationIndex: -1,
    recentFailures: [],
  };

  branch.forEach((entry, index) => {
    if (entry.type !== "message") return;
    const message = entry.message as unknown as Record<string, unknown>;
    const role = message.role;

    if (role === "assistant") {
      const content = message.content;
      if (!Array.isArray(content)) return;
      for (const part of content) {
        if (!part || typeof part !== "object" || !("type" in part)) continue;
        const p = part as { type: string; name?: string; arguments?: unknown };
        if (p.type !== "toolCall") continue;
        const name = typeof p.name === "string" ? p.name : "";
        const args = p.arguments;
        if (isStateChangingToolCall(name, args)) {
          signals.mutationSeen = true;
          signals.lastMutationIndex = index;
        }
        if (isVerificationToolCall(name, args)) {
          signals.verificationSeen = true;
          signals.lastVerificationIndex = index;
        }
      }
      return;
    }

    if (role === "toolResult") {
      const isError = message.isError === true;
      const toolName = typeof message.toolName === "string" ? message.toolName : "";
      const output = contentToText(message.content);
      if (isError || (toolName === "bash" && /(?:error|failed|failure|exception|traceback|not found|command not found)/i.test(output))) {
        signals.failureCount += 1;
        if (signals.recentFailures.length < MAX_RECENT_FAILURES) {
          signals.recentFailures.unshift({ command: toolName, output });
        }
      }
      if (isVerificationToolCall(toolName, undefined)) {
        // A bash tool result still counts as verification evidence.
        if (signals.lastVerificationIndex < 0) signals.lastVerificationIndex = index;
      }
      return;
    }

    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const exitCode = message.exitCode;
      const output = typeof message.output === "string" ? message.output : "";
      if (STATE_CHANGING_BASH.test(command)) {
        signals.mutationSeen = true;
        signals.lastMutationIndex = index;
      }
      if (VERIFICATION_BASH.test(command)) {
        signals.verificationSeen = true;
        signals.lastVerificationIndex = index;
      }
      if (exitCode !== undefined && exitCode !== 0) {
        signals.failureCount += 1;
        if (signals.recentFailures.length < MAX_RECENT_FAILURES) {
          signals.recentFailures.unshift({ command, output });
        }
      }
      return;
    }
  });

  return signals;
}

/**
 * Map branch signals + run state to a stage, following the plan's precedence:
 * repeated failures dominate, then near-final, then implementation, else initial.
 */
export function detectStage(signals: BranchSignals, state: AdvisorState): AdvisorStage {
  const hasMutation = signals.mutationSeen || state.run.mutationSeen;
  const hasFailures = signals.failureCount >= 2;
  const hasVerification = signals.verificationSeen;
  // Verification after the last mutation is the strongest "near final" signal we
  // can read deterministically from the branch.
  const isNearFinal = hasMutation && hasVerification && signals.lastVerificationIndex > signals.lastMutationIndex;

  if (hasFailures) return "recovery";
  if (isNearFinal) return "final-check";
  if (hasMutation) return "implementation";
  return "initial";
}