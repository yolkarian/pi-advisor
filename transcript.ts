/**
 * Curated transcript builder.
 *
 * The advisor should not receive the raw, full session: that is expensive, slow, and
 * leaks noise. Instead we assemble a compact, structured context with the pieces a
 * senior reviewer actually needs: the original task, the executor's current state,
 * lightweight project signals (git/diff/failures), a recent activity digest, and the
 * high-priority project constraints.
 *
 * Everything that goes to the advisor is run through `redactSecrets` when enabled.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { AdvisorStage } from "./stage.ts";
import { analyzeBranch, contentToText } from "./stage.ts";
import type { AdvisorState } from "./state.ts";
import { redactSecrets, looksLikeSecretPath, summarizeSecretFile } from "./redaction.ts";

export type CuratedTranscript = {
  text: string;
  messageCount: number;
  truncated: boolean;
};

const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_TOOL_RESULT_LINES = 200;
const MAX_ADVISOR_RESULT_CHARS = 360;
const MAX_USER_TASK_CHARS = 4_000;
const MAX_CONSTRAINT_LINES = 80;
const MAX_CONSTRAINT_CHARS = 4_000;
const MAX_GIT_SIGNAL_LINES = 60;
const MAX_FAILURE_OUTPUT_CHARS = 1_500;
const MAX_TOOL_CALL_ARG_CHARS = 160;

/** Keep head and tail of a long string, marking the omitted middle. */
function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.45);
  const tail = maxChars - head;
  const omitted = text.length - maxChars;
  return `${text.slice(0, head)}\n... [${omitted} chars omitted] ...\n${text.slice(-tail)}`;
}

/** Keep head + tail lines of a string (good for failed command output). */
function headAndTailLines(text: string, headLines: number, tailLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines) return text;
  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(-tailLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  return `${head}\n... [${omitted} lines omitted] ...\n${tail}`;
}

/** Truncate a single tool result string according to the plan's rules. */
function truncateToolResult(output: string, isError: boolean): string {
  const cleaned = output.replace(/\r\n/g, "\n").trimEnd();
  if (isError) {
    const sliced = headAndTailLines(cleaned, 40, 120);
    return truncateMiddle(sliced, MAX_TOOL_RESULT_CHARS);
  }
  // Cap line count first, then bytes.
  const lineCapped = truncateHead(cleaned, { maxLines: MAX_TOOL_RESULT_LINES, maxBytes: MAX_TOOL_RESULT_CHARS * 2 });
  return truncateMiddle(lineCapped.content, MAX_TOOL_RESULT_CHARS);
}

/** Compact one-line summary of a tool call's arguments. */
function summarizeToolCallArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const clip = (s: string) => (s.length > MAX_TOOL_CALL_ARG_CHARS ? `${s.slice(0, MAX_TOOL_CALL_ARG_CHARS)}…` : s);
  switch (name) {
    case "bash":
      return typeof a.command === "string" ? clip(a.command) : "";
    case "read":
    case "write":
    case "edit":
      return typeof a.path === "string" ? a.path : "";
    case "grep":
      return [typeof a.pattern === "string" ? `/${a.pattern}/` : "", typeof a.path === "string" ? a.path : ""].filter(Boolean).join(" ");
    case "find":
      return [typeof a.pattern === "string" ? a.pattern : "", typeof a.path === "string" ? a.path : ""].filter(Boolean).join(" ");
    case "ls":
      return typeof a.path === "string" ? a.path : "";
    default: {
      const json = JSON.stringify(a);
      return clip(json);
    }
  }
}

type FormattedMessage = {
  text: string;
  /** Whether this entry was a state-changing or verification action. */
  kind: "user" | "assistant" | "toolResult" | "bash" | "summary" | "other";
};

/** Format a single session message entry for the advisor transcript. */
function formatMessage(message: Record<string, unknown>, redact: boolean): FormattedMessage | null {
  const role = message.role;
  const redactText = (s: string) => (redact ? redactSecrets(s) : s);

  if (role === "user") {
    let text = contentToText(message.content);
    if (!text.trim()) return null;
    text = truncateMiddle(text, MAX_USER_TASK_CHARS);
    return { text: `### User\n${redactText(text)}`, kind: "user" };
  }

  if (role === "assistant") {
    const lines: string[] = [];
    const content = message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object" || !("type" in part)) continue;
        const p = part as { type: string; text?: string; name?: string; arguments?: unknown };
        if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
          lines.push(redactText(p.text));
        } else if (p.type === "toolCall") {
          const name = typeof p.name === "string" ? p.name : "tool";
          const args = summarizeToolCallArgs(name, p.arguments);
          lines.push(`→ ${name}(${redactText(args)})`);
        }
        // Skip thinking blocks: they are intermediate reasoning, not evidence.
      }
    }
    if (lines.length === 0) return null;
    return { text: `### Assistant\n${lines.join("\n")}`, kind: "assistant" };
  }

  if (role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const isError = message.isError === true;
    const rawOutput = contentToText(message.content);
    if (toolName === "advisor") {
      // Show prior advisor guidance briefly so it does not repeat itself.
      const digest = truncateMiddle(rawOutput, MAX_ADVISOR_RESULT_CHARS);
      return { text: `### Previous advisor guidance\n${redactText(digest)}`, kind: "toolResult" };
    }
    // Never send secret file contents even if the executor read them.
    const pathArg = (message as { input?: { path?: string } }).input?.path;
    if (pathArg && looksLikeSecretPath(pathArg)) {
      return { text: `### Tool result (${toolName})\n${summarizeSecretFile(pathArg, rawOutput)}`, kind: "toolResult" };
    }
    const output = truncateToolResult(redactText(rawOutput), isError);
    const tag = isError ? " [FAILED]" : "";
    return { text: `### Tool result (${toolName})${tag}\n${output}`, kind: "toolResult" };
  }

  if (role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "(unknown)";
    const exitCode = message.exitCode;
    const cancelled = message.cancelled === true;
    const rawOutput = typeof message.output === "string" ? message.output : "";
    const output = truncateToolResult(redactText(rawOutput), exitCode !== 0 && !cancelled);
    const status = cancelled ? "cancelled" : `exit ${exitCode ?? "?"}`;
    return { text: `### Bash: $ ${redactText(command)} (${status})\n${output}`, kind: "bash" };
  }

  if (role === "compactionSummary" || role === "branchSummary") {
    const summary = typeof message.summary === "string" ? message.summary : "";
    if (!summary.trim()) return null;
    return { text: `### Earlier session (summarized)\n${redactText(truncateMiddle(summary, 2_000))}`, kind: "summary" };
  }

  // Custom / other message roles: surface display content only.
  if (role === "custom") {
    const text = contentToText(message.content);
    if (!text.trim()) return null;
    return { text: `### Note\n${redactText(truncateMiddle(text, 1_000))}`, kind: "other" };
  }

  return null;
}

/** Read a constraints file (AGENTS.md / SYSTEM.md) from cwd, truncated. */
function readConstraintsFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    const lineCapped = truncateHead(trimmed, { maxLines: MAX_CONSTRAINT_LINES, maxBytes: MAX_CONSTRAINT_CHARS * 2 });
    return truncateMiddle(lineCapped.content, MAX_CONSTRAINT_CHARS);
  } catch {
    return null;
  }
}

/** Run a git command via pi.exec and return trimmed stdout (or an error note). */
async function gitSignal(pi: ExtensionAPI, args: string[], cwd: string): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout: 8_000 });
  if (result.code !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    return err ? `(git ${args.join(" ")} failed: ${err.slice(0, 200)})` : "(not a git repo)";
  }
  return result.stdout.trim();
}

function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n... (${lines.length - max} more lines omitted)`;
}

/**
 * Build the curated advisor context from the live session.
 */
export async function buildCuratedTranscript(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  options: {
    maxMessages: number;
    redactSecrets: boolean;
    stage: AdvisorStage;
    state: AdvisorState;
  },
): Promise<CuratedTranscript> {
  const { maxMessages, redactSecrets: redact, stage, state } = options;
  const branch = ctx.sessionManager.getBranch();
  const signals = analyzeBranch(branch);
  let truncated = false;

  // --- <task> ---
  const firstUser = branch.find((e) => e.type === "message" && (e.message as { role?: string }).role === "user");
  let taskText = "(no user task captured yet)";
  if (firstUser && firstUser.type === "message") {
    const formatted = formatMessage(firstUser.message as unknown as Record<string, unknown>, redact);
    if (formatted) taskText = formatted.text.replace(/^### User\n/, "");
  }
  // Most recent user steering message (if different from the first).
  const lastUser = [...branch].reverse().find((e) => e.type === "message" && (e.message as { role?: string }).role === "user");
  let recentSteering = "";
  if (lastUser && lastUser.type === "message" && lastUser !== firstUser) {
    const formatted = formatMessage(lastUser.message as unknown as Record<string, unknown>, redact);
    if (formatted) recentSteering = formatted.text.replace(/^### User\n/, "");
  }

  // --- <executor_state> ---
  const model = ctx.model;
  const modelLine = model ? `${model.provider}/${model.id}` : "(none)";
  const thinkingLevel = pi.getThinkingLevel();
  const activeTools = pi.getActiveTools();
  const advisorCalls = state.run.callsThisRun;

  // --- <project_signals> ---
  const [statusOut, diffStatOut] = await Promise.all([
    gitSignal(pi, ["status", "--porcelain"], ctx.cwd),
    gitSignal(pi, ["diff", "--stat"], ctx.cwd),
  ]);
  let projectSignals = `git status:\n${capLines(statusOut, MAX_GIT_SIGNAL_LINES)}`;
  if (diffStatOut && diffStatOut !== "(not a git repo)" && !diffStatOut.startsWith("(git")) {
    projectSignals += `\n\ngit diff --stat:\n${capLines(diffStatOut, MAX_GIT_SIGNAL_LINES)}`;
  }
  if (signals.recentFailures.length > 0) {
    const failures = signals.recentFailures
      .map((f) => `$ ${f.command || "(tool)"}\n${truncateMiddle(f.output, MAX_FAILURE_OUTPUT_CHARS)}`)
      .join("\n\n");
    projectSignals += `\n\nrecent failures:\n${failures}`;
  }

  // --- <recent_transcript> ---
  // Keep the original task out of the recent window (it's in <task>), then take the
  // last N entries. Compaction summaries are kept so the advisor has continuity.
  const formattedEntries: FormattedMessage[] = [];
  const recentSlice = branch.slice(-Math.max(maxMessages, 1));
  for (const entry of recentSlice) {
    if (entry.type !== "message") continue;
    if (entry === firstUser) continue;
    const formatted = formatMessage(entry.message as unknown as Record<string, unknown>, redact);
    if (formatted) formattedEntries.push(formatted);
  }
  if (formattedEntries.length > maxMessages) {
    truncated = true;
    formattedEntries.splice(0, formattedEntries.length - maxMessages);
  }

  const recentTranscript = formattedEntries.map((f) => f.text).join("\n\n") || "(no recent activity yet)";

  // --- <constraints> ---
  const constraintsParts: string[] = [];
  const agentsMd = readConstraintsFile(join(ctx.cwd, "AGENTS.md"));
  if (agentsMd) constraintsParts.push(`AGENTS.md:\n${agentsMd}`);
  const systemMd = readConstraintsFile(join(ctx.cwd, "SYSTEM.md"));
  if (systemMd) constraintsParts.push(`SYSTEM.md:\n${systemMd}`);
  const constraints = constraintsParts.join("\n\n") || "(none detected)";

  const messageCount = formattedEntries.length + (firstUser ? 1 : 0);

  const blocks = [
    `<task>\n${taskText}${recentSteering ? `\n\nLatest user steering:\n${recentSteering}` : ""}\n</task>`,
    `<executor_state>\nmodel: ${modelLine}\nthinking: ${thinkingLevel}\ncwd: ${ctx.cwd}\nactive_tools: ${activeTools.join(", ") || "(none)"}\nstage: ${stage}\nadvisor_calls_this_run: ${advisorCalls}\n</executor_state>`,
    `<project_signals>\n${projectSignals}\n</project_signals>`,
    `<recent_transcript>\n${recentTranscript}\n</recent_transcript>`,
    `<constraints>\n${constraints}\n</constraints>`,
  ];

  return {
    text: blocks.join("\n\n"),
    messageCount,
    truncated,
  };
}