/**
 * TUI rendering for the `advisor` tool.
 *
 * Collapsed view stays on one line so advisor calls do not crowd the transcript:
 *   🧠 advisor: COURSE_CORRECT · 3 actions · 812 tokens · 4.2s
 * Expanded view shows the full structured advice plus call metadata.
 */

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type AdvisorToolDetails = {
  advisorModel: string;
  stage: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  elapsedMs: number;
  contextMessages: number;
  truncated: boolean;
  /** Parsed VERDICT value, when available. */
  verdict?: string;
  /** True when the tool result is a budget/error/disabled notice rather than advice. */
  notice?: boolean;
};

type RenderResultOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = {
  lastComponent?: unknown;
};

const VALID_VERDICTS = new Set(["ON_TRACK", "COURSE_CORRECT", "NOT_DONE", "STOP"]);

/** Extract the VERDICT value from the advisor output, if present. */
export function parseVerdict(text: string): string | undefined {
  const match = text.match(/VERDICT:\s*([A-Z_]+)/i);
  if (!match) return undefined;
  const verdict = match[1].toUpperCase();
  return VALID_VERDICTS.has(verdict) ? verdict : match[1];
}

/** Count numbered actions under a NEXT_ACTIONS: section. */
function countActions(text: string): number {
  const section = text.split(/^NEXT_ACTIONS:/im)[1];
  if (!section) return 0;
  // Stop at the next section header.
  const block = section.split(/^(?:RISKS|VERIFY):/im)[0] ?? "";
  const matches = block.match(/^\s*\d+\.\s+/gm);
  return matches ? matches.length : 0;
}

function formatTokens(n: number): string {
  if (n <= 0) return "0 tokens";
  if (n < 1000) return `${n} tokens`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${Math.round(n / 1000)}k tokens`;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function verdictColor(theme: Theme, verdict?: string): (text: string) => string {
  switch (verdict) {
    case "ON_TRACK":
      return (t) => theme.fg("success", t);
    case "COURSE_CORRECT":
    case "NOT_DONE":
      return (t) => theme.fg("warning", t);
    case "STOP":
      return (t) => theme.fg("error", t);
    default:
      return (t) => theme.fg("accent", t);
  }
}

const BRAIN = "🧠";

/** Render the tool call header. The tool takes no parameters. */
export function renderAdvisorCall(
  _args: object,
  theme: Theme,
  context: RenderContext,
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(`${theme.fg("toolTitle", theme.bold("advisor "))}${theme.fg("muted", "(consult reviewer)")}`);
  return text;
}

/**
 * Render the advisor result. Collapsed shows a one-line digest; expanded shows the
 * full advice and call metadata.
 */
export function renderAdvisorResult(
  result: { content: Array<{ type: string; text?: string }>; details?: AdvisorToolDetails },
  options: RenderResultOptions,
  theme: Theme,
  context: RenderContext,
): Text {
  const output = result.content
    .map((c) => c.text)
    .join("")
    .trim();

  if (options.isPartial) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(`${BRAIN} ${theme.fg("muted", "advisor: consulting…")}`);
    return text;
  }

  const details = result.details;
  const verdict = details?.verdict ?? parseVerdict(output);

  // Notices (disabled / budget / error) render as plain muted text, no digest.
  if (details?.notice) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(`${BRAIN} ${theme.fg("muted", output)}`);
    return text;
  }

  if (options.expanded) {
    const lines: string[] = [];
    if (details) {
      lines.push(
        `${theme.fg("toolTitle", theme.bold("Advisor model"))}: ${theme.fg("dim", details.advisorModel)}`,
      );
      lines.push(`${theme.fg("toolTitle", "Stage")}: ${theme.fg("dim", details.stage)}`);
      lines.push(
        `${theme.fg("toolTitle", "Usage")}: ${theme.fg("dim", `in=${details.usage.inputTokens}, out=${details.usage.outputTokens}`)}`,
      );
      lines.push(`${theme.fg("toolTitle", "Elapsed")}: ${theme.fg("dim", formatElapsed(details.elapsedMs))}`);
      lines.push(
        `${theme.fg("toolTitle", "Context")}: ${theme.fg("dim", `${details.contextMessages} messages${details.truncated ? ", truncated" : ""}`)}`,
      );
      lines.push("");
    }
    lines.push(theme.fg("toolOutput", output));
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(lines.join("\n"));
    return text;
  }

  // Collapsed one-line digest.
  const parts: string[] = [];
  const vColor = verdictColor(theme, verdict);
  parts.push(`${BRAIN} ${theme.fg("toolTitle", "advisor:")}`);
  if (verdict) {
    parts.push(vColor(verdict));
  } else if (!output) {
    parts.push(theme.fg("muted", "(no output)"));
  }
  if (details && !details.notice) {
    const actions = countActions(output);
    if (actions > 0) parts.push(theme.fg("dim", `${actions} actions`));
    if (details.usage.outputTokens > 0) parts.push(theme.fg("dim", formatTokens(details.usage.outputTokens)));
    if (details.elapsedMs > 0) parts.push(theme.fg("dim", formatElapsed(details.elapsedMs)));
  }
  const hint = ` (${keyHint("app.tools.expand", "to expand")})`;
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(`${parts.join(theme.fg("dim", " · "))}${hint}`);
  return text;
}