/**
 * Pi-native advisor backend.
 *
 * Calls the configured advisor model through Pi's own provider/model registry, so the
 * extension reuses Pi's API key management, provider configs, and reasoning support.
 * The call is a single non-streaming completion with no tools: the advisor returns text
 * only and never participates in a tool loop.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import type { AdvisorConfig } from "../config.ts";
import type { AdvisorUsage } from "../state.ts";
import type { AdvisorResponse } from "./types.ts";

/**
 * Resolve the configured advisor model and call it with the curated transcript as a
 * single user message. Throws with a human-readable message on any failure so the
 * tool executor can surface it without crashing the agent loop.
 */
export async function callAdvisorModel(
  ctx: ExtensionContext,
  config: AdvisorConfig,
  system: string,
  userContent: string,
  signal: AbortSignal | undefined,
): Promise<AdvisorResponse> {
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(
      `advisor model "${config.provider}/${config.model}" is not registered. ` +
        `Run \`pi --list-models\` or /model to see available models, then \`/advisor on ${config.provider}/${config.model}\`.`,
    );
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok
        ? `no API key configured for advisor model "${config.provider}/${config.model}". Add auth via /login or auth.json.`
        : `advisor auth error for "${config.provider}/${config.model}": ${auth.error}`,
    );
  }

  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: userContent }],
    timestamp: Date.now(),
  };

  // Only set reasoning for models that support it; providers clamp the rest to "off".
  const options: Record<string, unknown> = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    maxTokens: config.maxAdvisorOutputTokens,
  };
  if (signal) options.signal = signal;
  if (model.reasoning) options.reasoning = config.reasoning;

  const startedAt = Date.now();
  const response = await completeSimple(model, { systemPrompt: system, messages: [userMessage] }, options);
  const elapsedMs = Date.now() - startedAt;

  if (response.stopReason === "aborted") {
    throw new Error("advisor call was aborted");
  }
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "advisor model returned an error");
  }

  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  const usage: AdvisorUsage = {
    inputTokens: response.usage.input,
    outputTokens: response.usage.output,
    totalTokens: response.usage.totalTokens,
  };

  return {
    text: text || "(advisor returned no text)",
    usage,
    elapsedMs,
    model: `${config.provider}/${config.model}`,
  };
}