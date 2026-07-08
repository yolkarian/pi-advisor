/**
 * The `/advisor` command and its subcommands:
 *
 *   /advisor                       -> show status
 *   /advisor on [provider/model]   -> enable (and optionally set the advisor model)
 *   /advisor off                   -> disable
 *   /advisor config                -> show all config
 *   /advisor config key=value      -> set one config key
 *   /advisor ask                   -> run one advisor call now and inject the guidance
 *
 * `/advisor ask` bypasses the per-run budget because it is an explicit user action,
 * but it still counts toward session usage.
 */

import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorConfig } from "./config.ts";
import { applyConfigAssignment, formatConfig, parseProviderModel, persistConfig } from "./config.ts";
import type { AdvisorState } from "./state.ts";
import type { AdvisorCallOutcome, RunAdvisorCall } from "./tool.ts";

export type { AdvisorCallOutcome };

export type AdvisorCommandDeps = {
  pi: ExtensionAPI;
  config: AdvisorConfig;
  state: AdvisorState;
  /** Build context + call the advisor model. Throws on failure. */
  runAdvisorCall: RunAdvisorCall;
};

type ReportKind = "info" | "warning" | "error";
type CommandResult = { text: string; kind: ReportKind };

function notify(ctx: ExtensionCommandContext, message: string, kind: ReportKind = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, kind);
  else if (kind === "error") console.error(`[pi-advisor] ${message}`);
  else console.log(`[pi-advisor] ${message}`);
}

/** Run an async task under a cancellable loader in TUI mode; bare await otherwise. */
async function withLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") {
    return fn(new AbortController().signal);
  }
  return ctx.ui.custom<T>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, label);
    loader.onAbort = () => done(new Error("Cancelled") as unknown as T);
    fn(loader.signal)
      .then(done)
      .catch((err) => done(err as unknown as T));
    return loader;
  });
}

function formatHistory(state: AdvisorState): string {
  const history = state.run.history;
  if (history.length === 0) return "(no advisor calls this session)";
  const last = history.slice(-5);
  return last
    .map((c) => `#${c.index} ${c.digest} · ${c.usage.outputTokens} out · ${(c.elapsedMs / 1000).toFixed(1)}s`)
    .join("\n");
}

function handleStatus(deps: AdvisorCommandDeps, _ctx: ExtensionCommandContext): CommandResult {
  const { config, state } = deps;
  return {
    kind: "info",
    text: [
      `Advisor: ${config.enabled ? "enabled" : "disabled"}`,
      `Backend: ${config.mode}`,
      `Model: ${config.provider}/${config.model}`,
      `Reasoning: ${config.reasoning}`,
      `Max uses per run: ${config.maxUsesPerRun}`,
      `Strict before first write: ${config.strictBeforeFirstWrite}`,
      `Redaction: ${config.redactSecrets}`,
      `Calls this session: ${state.run.callsThisSession}`,
      "",
      "Recent calls:",
      formatHistory(state),
    ].join("\n"),
  };
}

function handleOn(deps: AdvisorCommandDeps, _ctx: ExtensionCommandContext, arg: string): CommandResult {
  const { config, pi } = deps;
  config.enabled = true;
  if (arg.trim()) {
    const ref = parseProviderModel(arg.trim());
    if (!ref) {
      return {
        kind: "warning",
        text: `Invalid provider/model "${arg.trim()}". Expected form like openai-codex/gpt-5.5.`,
      };
    }
    config.provider = ref.provider;
    config.model = ref.model;
  }
  persistConfig(config);
  // Make sure the advisor tool is active alongside the built-in tools.
  const active = pi.getActiveTools();
  if (!active.includes("advisor")) {
    pi.setActiveTools([...active, "advisor"]);
  }
  return {
    kind: "info",
    text: `Advisor enabled.\nModel: ${config.provider}/${config.model}\nReasoning: ${config.reasoning}`,
  };
}

function handleOff(deps: AdvisorCommandDeps, _ctx: ExtensionCommandContext): CommandResult {
  const { config, pi } = deps;
  config.enabled = false;
  persistConfig(config);
  // Leave the tool registered but deactivate it so it leaves the system prompt.
  const active = pi.getActiveTools();
  if (active.includes("advisor")) {
    pi.setActiveTools(active.filter((t) => t !== "advisor"));
  }
  return { kind: "info", text: "Advisor disabled. The advisor() tool is now inactive." };
}

function handleConfig(deps: AdvisorCommandDeps, _ctx: ExtensionCommandContext, arg: string): CommandResult {
  const { config } = deps;
  const trimmed = arg.trim();
  if (!trimmed) {
    return { kind: "info", text: formatConfig(config) };
  }
  // Support multiple key=value pairs separated by spaces.
  const results = trimmed.split(/\s+/).map((assignment) => applyConfigAssignment(config, assignment));
  persistConfig(config);
  const hasError = results.some(
    (r) => r.startsWith("Invalid") || r.includes(" must be ") || r.startsWith("Unknown"),
  );
  return {
    kind: hasError ? "warning" : "info",
    text: `${results.join("\n")}\n\nSaved. Current config:\n\n${formatConfig(config)}`,
  };
}

async function handleAsk(deps: AdvisorCommandDeps, ctx: ExtensionCommandContext): Promise<CommandResult> {
  const { pi, config, runAdvisorCall } = deps;
  if (config.mode === "external-cli" && !config.externalCli.command) {
    return { kind: "error", text: "Advisor ask failed: external CLI command not configured." };
  }

  try {
    const outcome = await withLoader(ctx, "Consulting advisor…", (signal) => runAdvisorCall(ctx, signal));
    // Insert the guidance into the session as context the executor can act on, and
    // trigger a turn so the executor reviews it.
    await pi.sendMessage(
      {
        customType: "advisor-ask",
        content: `Advisor guidance — review and act on it as needed:\n\n${outcome.text}`,
        display: true,
        details: outcome.details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return {
      kind: "info",
      text: `Advisor guidance inserted into the session (${outcome.details.advisorModel}, ${outcome.details.stage}).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", text: `Advisor ask failed: ${msg}` };
  }
}

export function createAdvisorCommand(deps: AdvisorCommandDeps) {
  return {
    description: "Control the advisor strategy: status | on [provider/model] | off | config [key=value] | ask",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const space = trimmed.indexOf(" ");
      const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
      const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();

      let result: CommandResult;
      switch (sub) {
        case "":
        case "status":
          result = handleStatus(deps, ctx);
          break;
        case "on":
          result = handleOn(deps, ctx, rest);
          break;
        case "off":
          result = handleOff(deps, ctx);
          break;
        case "config":
        case "set":
          result = handleConfig(deps, ctx, rest);
          break;
        case "ask":
          result = await handleAsk(deps, ctx);
          break;
        default:
          result = {
            kind: "warning",
            text: `Unknown /advisor subcommand "${sub}". Usage: /advisor status | on [provider/model] | off | config [key=value] | ask`,
          };
      }
      notify(ctx, result.text, result.kind);
    },
  };
}