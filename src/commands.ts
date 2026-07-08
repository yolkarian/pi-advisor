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
import { advisorShouldBeActive, applyConfigAssignment, formatConfig, parseProviderModel, persistConfig } from "./config.ts";
import type { AdvisorState } from "./state.ts";
import type { AdvisorCallOutcome, RunAdvisorCall } from "./tool.ts";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type { AdvisorCallOutcome };

export type AdvisorCommandDeps = {
  pi: ExtensionAPI;
  config: AdvisorConfig;
  state: AdvisorState;
  /** Build context + call the advisor model. Throws on failure. */
  runAdvisorCall: RunAdvisorCall;
  /** Available advisor models as `provider/id`, captured at session start for `/advisor on` completion. */
  getModels?: () => string[];
  /** Add/remove the advisor tool from the active set; returns whether it is now active. */
  syncToolActive?: (model: { provider: string; id: string } | undefined) => boolean;
};

const SUBCOMMANDS: ReadonlyArray<{ value: string; label: string; description: string }> = [
  { value: "status", label: "status", description: "show advisor status" },
  { value: "on", label: "on", description: "enable (optionally set provider/model)" },
  { value: "off", label: "off", description: "disable" },
  { value: "config", label: "config", description: "show or set config keys" },
  { value: "set", label: "set", description: "alias for config" },
  { value: "ask", label: "ask", description: "run one advisor call now" },
];

type ConfigKind = "boolean" | "string" | "int" | "enum" | "model" | "provider";
const CONFIG_KEYS: ReadonlyArray<{ key: string; kind: ConfigKind; values?: string[] }> = [
  { key: "enabled", kind: "boolean" },
  { key: "provider", kind: "provider" },
  { key: "model", kind: "model" },
  { key: "reasoning", kind: "enum", values: ["minimal", "low", "medium", "high", "xhigh"] },
  { key: "maxUsesPerRun", kind: "int" },
  { key: "maxContextMessages", kind: "int" },
  { key: "maxAdvisorOutputTokens", kind: "int" },
  { key: "strictBeforeFirstWrite", kind: "boolean" },
  { key: "redactSecrets", kind: "boolean" },
  { key: "mode", kind: "enum", values: ["pi-ai", "external-cli"] },
];

function currentValueString(config: AdvisorConfig, key: string): string {
  switch (key) {
    case "enabled": return String(config.enabled);
    case "provider": return config.provider;
    case "model": return config.model;
    case "reasoning": return config.reasoning;
    case "maxUsesPerRun": return String(config.maxUsesPerRun);
    case "maxContextMessages": return String(config.maxContextMessages);
    case "maxAdvisorOutputTokens": return String(config.maxAdvisorOutputTokens);
    case "strictBeforeFirstWrite": return String(config.strictBeforeFirstWrite);
    case "redactSecrets": return String(config.redactSecrets);
    case "mode": return config.mode;
    default: return "";
  }
}

/**
 * Completion for `/advisor <args>`. `argumentPrefix` is everything after the command
 * name and the framework replaces that whole span with the chosen item's `value`, so
 * for multi-token args the returned `value` must be the fully reconstructed args string.
 */
function buildAdvisorCompletions(deps: AdvisorCommandDeps, argumentPrefix: string): AutocompleteItem[] | null {
  const endsWithSpace = /\s$/.test(argumentPrefix);
  const words = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  const current = endsWithSpace ? "" : (words[words.length - 1] ?? "");
  const completed = endsWithSpace ? words : words.slice(0, -1);
  const { config, getModels } = deps;

  // Subcommand position.
  if (completed.length === 0) {
    const items = SUBCOMMANDS.filter((s) => s.value.startsWith(current));
    return items.length ? items.map((s) => ({ value: s.value, label: s.label, description: s.description })) : null;
  }

  const sub = completed[0];
  const prev = completed.slice(1);
  const join = (...parts: string[]) => parts.filter((p) => p.length > 0).join(" ");

  // /advisor on [provider/model]
  if (sub === "on") {
    const models = getModels ? getModels() : [];
    if (models.length === 0) return null;
    const items = models.filter((m) => m.startsWith(current)).map((m) => ({ value: join(sub, ...prev, m), label: m }));
    return items.length ? items : null;
  }

  // /advisor config|set [key=value]...
  if (sub === "config" || sub === "set") {
    const eq = current.indexOf("=");
    if (eq >= 0) {
      // Value side: complete the value for the key being typed.
      const key = current.slice(0, eq);
      const valPrefix = current.slice(eq + 1);
      const meta = CONFIG_KEYS.find((k) => k.key === key);
      if (!meta) return null;
      let vals: string[] = [];
      if (meta.kind === "boolean") vals = ["true", "false"];
      else if (meta.kind === "enum" && meta.values) vals = meta.values;
      else if (meta.kind === "model") vals = getModels ? getModels() : [];
      else if (meta.kind === "provider") {
        const models = getModels ? getModels() : [];
        vals = [...new Set(models.map((m) => m.split("/")[0] ?? ""))];
      } else return null; // int/string: no value completion
      const items = vals.filter((v) => v.startsWith(valPrefix)).map((v) => ({ value: join(sub, ...prev, `${key}=${v}`), label: v }));
      return items.length ? items : null;
    }
    // Key side: complete the config key and append "=".
    const items = CONFIG_KEYS.filter((k) => k.key.startsWith(current)).map((k) => ({
      value: join(sub, ...prev, `${k.key}=`),
      label: k.key,
      description: `current: ${currentValueString(config, k.key)}`,
    }));
    return items.length ? items : null;
  }

  return null;
}

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

function handleStatus(deps: AdvisorCommandDeps, ctx: ExtensionCommandContext): CommandResult {
  const { config, state } = deps;
  const active = advisorShouldBeActive(config, ctx.model);
  const stateLine = config.enabled
    ? active
      ? "enabled"
      : "enabled (inactive: advisor model == current model)"
    : "disabled";
  return {
    kind: "info",
    text: [
      `Advisor: ${stateLine}`,
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

function handleOn(deps: AdvisorCommandDeps, ctx: ExtensionCommandContext, arg: string): CommandResult {
  const { config, syncToolActive } = deps;
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
  const active = syncToolActive ? syncToolActive(ctx.model) : true;
  if (!active) {
    return {
      kind: "warning",
      text:
        `Advisor enabled but inactive: advisor model ${config.provider}/${config.model} ` +
        `equals the current model. Switch the executor model or /advisor on <other-model> to activate.`,
    };
  }
  return {
    kind: "info",
    text: `Advisor enabled.\nModel: ${config.provider}/${config.model}\nReasoning: ${config.reasoning}`,
  };
}

function handleOff(deps: AdvisorCommandDeps, ctx: ExtensionCommandContext): CommandResult {
  const { config, syncToolActive } = deps;
  config.enabled = false;
  persistConfig(config);
  // Deactivate the tool so it leaves the system prompt.
  syncToolActive?.(ctx.model);
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
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null =>
      buildAdvisorCompletions(deps, argumentPrefix),
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