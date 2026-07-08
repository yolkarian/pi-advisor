/**
 * pi-advisor — Advisor strategy extension for the Pi coding agent.
 *
 * A cheap executor model owns the full coding loop. At high-leverage moments it calls
 * the zero-parameter `advisor()` tool, which assembles a curated transcript of the
 * current session, consults a stronger advisor model, and returns concise strategic
 * guidance as a tool result. The advisor never edits files, runs commands, or talks to
 * the user; it only steers the executor.
 *
 * Commands: `/advisor status | on [provider/model] | off | config [key=value] | ask`
 * Config:   `~/.pi/agent/advisor.json`
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  loadAdvisorConfig,
  type AdvisorConfig,
} from "./config.ts";
import { createAdvisorState, type AdvisorState, type AdvisorUsage } from "./state.ts";
import { buildAdvisorSystemPrompt, buildExecutorAdvisorGuidance } from "./prompt.ts";
import { analyzeBranch, detectStage, isStateChangingToolCall } from "./stage.ts";
import { buildCuratedTranscript } from "./transcript.ts";
import { callAdvisorModel, type AdvisorResponse } from "./adapter.ts";
import { callExternalCliAdvisor } from "./external-cli.ts";
import {
  parseVerdict,
  renderAdvisorCall,
  renderAdvisorResult,
  type AdvisorToolDetails,
} from "./render.ts";
import { createAdvisorCommand, type AdvisorCallOutcome } from "./commands.ts";

type ToolContent = { type: "text"; text: string };
type ToolResult = {
  content: ToolContent[];
  details: AdvisorToolDetails;
};

function textContent(text: string): ToolContent {
  return { type: "text", text };
}

function noticeResult(text: string): ToolResult {
  return {
    content: [textContent(text)],
    details: {
      advisorModel: "",
      stage: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      elapsedMs: 0,
      contextMessages: 0,
      truncated: false,
      notice: true,
    },
  };
}

export default function advisorExtension(pi: ExtensionAPI) {
  const config: AdvisorConfig = loadAdvisorConfig();
  const state: AdvisorState = createAdvisorState();

  /**
   * Shared core: build the curated context for the current session, call the advisor
   * model, and record usage. Used by both the `advisor()` tool and `/advisor ask`.
   * Throws on failure so callers can surface a graceful notice.
   */
  async function runAdvisorCall(
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
    onStatus?: (msg: string) => void,
  ): Promise<AdvisorCallOutcome> {
    onStatus?.("Building advisor context…");

    const branch = ctx.sessionManager.getBranch();
    const signals = analyzeBranch(branch);
    const stage = detectStage(signals, state);

    const transcript = await buildCuratedTranscript(ctx, pi, {
      maxMessages: config.maxContextMessages,
      redactSecrets: config.redactSecrets,
      stage,
      state,
    });

    const modelLabel =
      config.mode === "external-cli" ? `cli:${config.externalCli.command}` : `${config.provider}/${config.model}`;
    onStatus?.(`Consulting advisor (${modelLabel})…`);

    const system = buildAdvisorSystemPrompt();
    let response: AdvisorResponse;
    if (config.mode === "external-cli") {
      response = await callExternalCliAdvisor(config, system, transcript.text, signal);
    } else {
      response = await callAdvisorModel(ctx, config, system, transcript.text, signal);
    }

    const verdict = parseVerdict(response.text);
    const usage: AdvisorUsage = {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
    };
    state.recordAdvisorCall({
      stage,
      usage,
      elapsedMs: response.elapsedMs,
      model: response.model,
      truncated: transcript.truncated,
      digest: verdict ? `${stage} · ${verdict}` : stage,
    });

    const details: AdvisorToolDetails = {
      advisorModel: response.model,
      stage,
      usage,
      elapsedMs: response.elapsedMs,
      contextMessages: transcript.messageCount,
      truncated: transcript.truncated,
      verdict,
    };

    return { text: response.text, details };
  }

  // --- /advisor command ---
  pi.registerCommand(
    "advisor",
    createAdvisorCommand({
      pi,
      config,
      state,
      runAdvisorCall: (ctx, signal) => runAdvisorCall(ctx, signal),
    }),
  );

  // --- Keep the tool active/enabled in sync with config across sessions ---
  function ensureAdvisorActive(): void {
    if (!config.enabled) return;
    const active = pi.getActiveTools();
    if (!active.includes("advisor")) {
      pi.setActiveTools([...active, "advisor"]);
    }
  }

  pi.on("session_start", () => {
    ensureAdvisorActive();
  });

  // --- Per-run reset + executor prompt injection ---
  pi.on("before_agent_start", async (event) => {
    state.startRun();
    if (!config.enabled) return undefined;
    ensureAdvisorActive();
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildExecutorAdvisorGuidance(config)}`,
    };
  });

  // --- Track mutations, advisor calls, and the optional strict gate ---
  pi.on("tool_call", (event) => {
    if (!config.enabled) return;

    if (event.toolName === "advisor") {
      state.markAdvisorCalled();
      return;
    }

    if (isStateChangingToolCall(event.toolName, event.input)) {
      if (config.strictBeforeFirstWrite && !state.run.advisorCalledBeforeMutation) {
        return {
          block: true,
          reason:
            "Call advisor() before the first state-changing action on this complex task. " +
            "Disable with /advisor config strictBeforeFirstWrite=false.",
        };
      }
      state.markMutationSeen();
    }
  });

  // --- The advisor tool ---
  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Consult a stronger reviewer model for strategic coding guidance. The advisor sees the current session context and returns a concise plan, correction, or stop signal. It cannot edit files or run commands. Takes no parameters.",
    promptSnippet:
      "advisor: consult a stronger reviewer model before major coding decisions, when stuck, and before final completion.",
    promptGuidelines: [
      "Use advisor after initial orientation (reading relevant files) and before substantive edits on complex tasks.",
      "Use advisor when repeated errors, failing tests, or uncertainty suggest the current approach may be wrong.",
      "Use advisor before declaring a non-trivial coding task complete, after writing changes and running verification.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      if (!config.enabled) {
        return noticeResult("Advisor is disabled.");
      }
      if (state.budgetExceeded(config)) {
        return noticeResult("Advisor budget exceeded for this run. Continue without advisor.");
      }

      const onStatus = onUpdate
        ? (msg: string) => onUpdate({ content: [textContent(msg)], details: noticeResult("").details })
        : undefined;

      try {
        const outcome = await runAdvisorCall(ctx, signal ?? ctx.signal, onStatus);
        return {
          content: [textContent(outcome.text)],
          details: outcome.details,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return noticeResult(
          `Advisor call failed: ${msg}. Continue with local evidence and verification.`,
        );
      }
    },

    renderCall: renderAdvisorCall,
    renderResult: renderAdvisorResult,
  });

  // --- Render the manual /advisor ask guidance as a distinct message ---
  pi.registerMessageRenderer("advisor-ask", (message, options, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const prefix = `🧠 ${theme.fg("accent", "Advisor guidance")}`;
    if (options.expanded) {
      return new Text(`${prefix}\n${theme.fg("toolOutput", content)}`, 0, 0);
    }
    const firstLine = content.split("\n").find((l) => l.trim()) ?? "";
    return new Text(`${prefix}: ${theme.fg("muted", firstLine.slice(0, 120))}`, 0, 0);
  });
}