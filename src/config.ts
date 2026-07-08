/**
 * Advisor configuration.
 *
 * Reads and writes `~/.pi/agent/advisor.json` (set PI_CODING_AGENT_DIR to override
 * the agent dir). Project-local overrides are not supported on purpose: the advisor
 * is a personal reviewer and its model/budget should not shift per repository.
 *
 * The loaded config object is mutable and shared by reference across handlers, so
 * `/advisor on|off|config` can patch it in place and every later event sees the
 * change without a reload.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AdvisorMode = "pi-ai" | "external-cli";

export type AdvisorConfig = {
  /** Master switch. When false the tool is a no-op and no prompt is injected. */
  enabled: boolean;
  /** Advisor model provider, e.g. "openai-codex". */
  provider: string;
  /** Advisor model id, e.g. "gpt-5.5". */
  model: string;
  /** Reasoning effort for the advisor call. Ignored for non-reasoning models. */
  reasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Hard cap on advisor() calls per agent run (one user prompt = one run). */
  maxUsesPerRun: number;
  /** How many recent session messages to fold into the advisor context. */
  maxContextMessages: number;
  /** Max output tokens for a single advisor response. */
  maxAdvisorOutputTokens: number;
  /** When true, block the first state-changing tool call until advisor() is called. */
  strictBeforeFirstWrite: boolean;
  /** When true, scrub secrets out of the advisor context. */
  redactSecrets: boolean;
  /** Which backend calls the advisor model. */
  mode: AdvisorMode;
  /** External CLI backend settings. Only used when mode === "external-cli". */
  externalCli: {
    enabled: boolean;
    command: string;
    args: string[];
    /** Include a resume marker so the CLI can keep advisor state between calls. */
    resume: boolean;
  };
};

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: false,
  provider: "openai-codex",
  model: "gpt-5.5",
  reasoning: "xhigh",
  maxUsesPerRun: 3,
  maxContextMessages: 24,
  maxAdvisorOutputTokens: 1200,
  strictBeforeFirstWrite: false,
  redactSecrets: true,
  mode: "pi-ai",
  externalCli: {
    enabled: false,
    command: "pi",
    args: [],
    resume: true,
  },
};

const CONFIG_FILENAME = "advisor.json";

function configPath(): string {
  return join(getAgentDir(), CONFIG_FILENAME);
}

const REASONING_VALUES = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MODE_VALUES = new Set<AdvisorMode>(["pi-ai", "external-cli"]);

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function coerceString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Merge a parsed JSON object into a defaults-filled config, validating and
 * coercing each known field. Malformed values fall back to the default so a
 * bad config file never crashes the extension.
 */
function sanitize(raw: Record<string, unknown>): AdvisorConfig {
  const cfg: AdvisorConfig = structuredClone(DEFAULT_ADVISOR_CONFIG);

  if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
  if (coerceString(raw.provider)) cfg.provider = raw.provider as string;
  if (coerceString(raw.model)) cfg.model = raw.model as string;
  if (typeof raw.reasoning === "string" && REASONING_VALUES.has(raw.reasoning)) {
    cfg.reasoning = raw.reasoning as AdvisorConfig["reasoning"];
  }
  if (isNumber(raw.maxUsesPerRun) && raw.maxUsesPerRun >= 0) cfg.maxUsesPerRun = raw.maxUsesPerRun;
  if (isNumber(raw.maxContextMessages) && raw.maxContextMessages > 0) cfg.maxContextMessages = raw.maxContextMessages;
  if (isNumber(raw.maxAdvisorOutputTokens) && raw.maxAdvisorOutputTokens > 0) {
    cfg.maxAdvisorOutputTokens = raw.maxAdvisorOutputTokens;
  }
  if (typeof raw.strictBeforeFirstWrite === "boolean") cfg.strictBeforeFirstWrite = raw.strictBeforeFirstWrite;
  if (typeof raw.redactSecrets === "boolean") cfg.redactSecrets = raw.redactSecrets;
  if (typeof raw.mode === "string" && MODE_VALUES.has(raw.mode as AdvisorMode)) {
    cfg.mode = raw.mode as AdvisorMode;
  }

  if (raw.externalCli && typeof raw.externalCli === "object" && !Array.isArray(raw.externalCli)) {
    const cli = raw.externalCli as Record<string, unknown>;
    if (typeof cli.enabled === "boolean") cfg.externalCli.enabled = cli.enabled;
    if (coerceString(cli.command)) cfg.externalCli.command = cli.command as string;
    if (Array.isArray(cli.args) && cli.args.every((a) => typeof a === "string")) {
      cfg.externalCli.args = cli.args as string[];
    }
    if (typeof cli.resume === "boolean") cfg.externalCli.resume = cli.resume;
  }

  return cfg;
}

/**
 * Load advisor config from disk, merged with defaults.
 * Returns a fresh mutable object; callers keep and mutate it.
 */
export function loadAdvisorConfig(): AdvisorConfig {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(DEFAULT_ADVISOR_CONFIG);

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return structuredClone(DEFAULT_ADVISOR_CONFIG);
    }
    return sanitize(parsed as Record<string, unknown>);
  } catch (err) {
    console.error(`[pi-advisor] Failed to load config from ${path}: ${err}`);
    return structuredClone(DEFAULT_ADVISOR_CONFIG);
  }
}

/** Persist the current config to disk atomically enough for a user-settings file. */
export function saveAdvisorConfig(cfg: AdvisorConfig): void {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf-8");
  } catch (err) {
    console.error(`[pi-advisor] Failed to write config to ${path}: ${err}`);
  }
}

/**
 * Parse a `provider/model` argument (as used by `/advisor on openai-codex/gpt-5.5`)
 * into a validated patch. Returns null when the argument is not a valid ref.
 */
export function parseProviderModel(ref: string): { provider: string; model: string } | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

/**
 * Apply a `key=value` string (from `/advisor config maxUsesPerRun=2`) to a config
 * in place. Returns a human-readable result: either the normalized new value, or an
 * error message describing why the assignment was rejected.
 */
export function applyConfigAssignment(cfg: AdvisorConfig, assignment: string): string {
  const eq = assignment.indexOf("=");
  if (eq <= 0) {
    return `Invalid assignment "${assignment}". Expected key=value.`;
  }
  const key = assignment.slice(0, eq).trim();
  const rawValue = assignment.slice(eq + 1).trim();

  switch (key) {
    case "enabled":
    case "strictBeforeFirstWrite":
    case "redactSecrets": {
      if (rawValue === "true" || rawValue === "false") {
        cfg[key] = rawValue === "true";
        return `${key}=${cfg[key]}`;
      }
      return `${key} must be true or false`;
    }
    case "provider":
    case "model": {
      if (rawValue) {
        cfg[key] = rawValue;
        return `${key}=${rawValue}`;
      }
      return `${key} must be a non-empty string`;
    }
    case "reasoning": {
      if (REASONING_VALUES.has(rawValue)) {
        cfg.reasoning = rawValue as AdvisorConfig["reasoning"];
        return `${key}=${rawValue}`;
      }
      return `${key} must be one of: minimal, low, medium, high, xhigh`;
    }
    case "mode": {
      if (MODE_VALUES.has(rawValue as AdvisorMode)) {
        cfg.mode = rawValue as AdvisorMode;
        return `${key}=${rawValue}`;
      }
      return `${key} must be one of: pi-ai, external-cli`;
    }
    case "maxUsesPerRun":
    case "maxContextMessages":
    case "maxAdvisorOutputTokens": {
      const n = Number(rawValue);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return `${key} must be an integer`;
      }
      if (key === "maxUsesPerRun" && n < 0) return `${key} must be >= 0`;
      if ((key === "maxContextMessages" || key === "maxAdvisorOutputTokens") && n <= 0) {
        return `${key} must be > 0`;
      }
      cfg[key] = n;
      return `${key}=${n}`;
    }
    default:
      return `Unknown config key "${key}". Keys: enabled, provider, model, reasoning, maxUsesPerRun, maxContextMessages, maxAdvisorOutputTokens, strictBeforeFirstWrite, redactSecrets, mode`;
  }
}

/** Human-readable config dump for `/advisor config` and `/advisor status`. */
export function formatConfig(cfg: AdvisorConfig): string {
  const lines = [
    `enabled: ${cfg.enabled}`,
    `mode: ${cfg.mode}`,
    `provider: ${cfg.provider}`,
    `model: ${cfg.model}`,
    `reasoning: ${cfg.reasoning}`,
    `maxUsesPerRun: ${cfg.maxUsesPerRun}`,
    `maxContextMessages: ${cfg.maxContextMessages}`,
    `maxAdvisorOutputTokens: ${cfg.maxAdvisorOutputTokens}`,
    `strictBeforeFirstWrite: ${cfg.strictBeforeFirstWrite}`,
    `redactSecrets: ${cfg.redactSecrets}`,
    `externalCli.command: ${cfg.externalCli.command}`,
    `externalCli.args: ${cfg.externalCli.args.join(" ") || "(none)"}`,
    `externalCli.resume: ${cfg.externalCli.resume}`,
  ];
  return lines.join("\n");
}

/** Helper so command handlers can save without importing fs paths directly. */
export function persistConfig(cfg: AdvisorConfig): void {
  saveAdvisorConfig(cfg);
}

/** Re-export for modules that need the agent dir (e.g. transcript cwd display). */
export { getAgentDir, type ExtensionAPI };