/**
 * The `advisor()` tool and the shared advisor-call core.
 *
 * `runAdvisorCall` builds the curated context, calls the configured advisor backend,
 * records usage, and returns the structured guidance + render details. It is shared by
 * the LLM-callable `advisor()` tool and the manual `/advisor ask` command so both go
 * through exactly the same pipeline.
 *
 * `createAdvisorTool` closes over `pi`/`config`/`state` and returns both `runAdvisorCall`
 * (for the command) and `register` (to register the LLM tool).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { AdvisorConfig } from "./config.ts";
import type { AdvisorState, AdvisorUsage } from "./state.ts";
import { buildAdvisorSystemPrompt } from "./prompt.ts";
import { analyzeBranch, detectStage } from "./stage.ts";
import { buildCuratedTranscript } from "./transcript.ts";
import { callAdvisorModel } from "./adapter/pi-ai.ts";
import { callExternalCliAdvisor } from "./adapter/external-cli.ts";
import type { AdvisorResponse } from "./adapter/types.ts";
import {
  parseVerdict,
  renderAdvisorCall,
  renderAdvisorResult,
  type AdvisorToolDetails,
} from "./render.ts";

export type AdvisorCallOutcome = {
  text: string;
  details: AdvisorToolDetails;
};

export type RunAdvisorCall = (
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onStatus?: (msg: string) => void,
) => Promise<AdvisorCallOutcome>;

type ToolContent = { type: "text"; text: string };

function textContent(text: string): ToolContent {
  return { type: "text", text };
}

/** A minimal, non-error result used for disabled/budget/error notices. */
function noticeResult(text: string) {
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
    } satisfies AdvisorToolDetails,
  };
}

export type AdvisorToolHandle = {
  runAdvisorCall: RunAdvisorCall;
  register: () => void;
};

export function createAdvisorTool(pi: ExtensionAPI, config: AdvisorConfig, state: AdvisorState): AdvisorToolHandle {
  /**
   * Shared core: build the curated context for the current session, call the advisor
   * model, and record usage. Throws on failure so callers can surface a graceful notice.
   */
  const runAdvisorCall: RunAdvisorCall = async (ctx, signal, onStatus) => {
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
      config.mode === "external-cli"
        ? `cli:${config.externalCli.command}`
        : `${config.provider}/${config.model}`;
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
  };

  function register(): void {
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
          return noticeResult(`Advisor call failed: ${msg}. Continue with local evidence and verification.`);
        }
      },

      renderCall: renderAdvisorCall,
      renderResult: renderAdvisorResult,
    });
  }

  return { runAdvisorCall, register };
}