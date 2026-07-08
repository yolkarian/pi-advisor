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
 *
 * This entry point is the orchestrator only. Behavior lives in `src/`:
 *   src/tool.ts      – the advisor() tool + shared advisor-call core
 *   src/commands.ts  – the /advisor command
 *   src/adapter/     – pi-ai and external-cli backends
 *   src/transcript.ts, stage.ts, redaction.ts, prompt.ts, config.ts, state.ts, render.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { loadAdvisorConfig, advisorShouldBeActive } from "./src/config.ts";
import { createAdvisorState } from "./src/state.ts";
import { buildExecutorAdvisorGuidance } from "./src/prompt.ts";
import { isStateChangingToolCall } from "./src/stage.ts";
import { createAdvisorTool } from "./src/tool.ts";
import { createAdvisorCommand } from "./src/commands.ts";

export default function advisorExtension(pi: ExtensionAPI) {
  const config = loadAdvisorConfig();
  const state = createAdvisorState();
  const { runAdvisorCall, register: registerAdvisorTool } = createAdvisorTool(pi, config, state);

  // Models available to the advisor, captured at session start for `/advisor on` completion.
  const availableModels: string[] = [];

  /**
   * Add or remove the `advisor` tool from the active set based on whether it should be
   * active. `pi.registerTool` auto-activates newly registered tools, so we must explicitly
   * remove `advisor` when it should be off. It is off when disabled, and also when the
   * advisor model equals the current executor model (consulting yourself is pointless).
   * Returns whether the tool is now active.
   */
  function syncAdvisorToolActive(model: { provider: string; id: string } | undefined): boolean {
    const want = advisorShouldBeActive(config, model);
    const active = pi.getActiveTools();
    if (want && !active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
    else if (!want && active.includes("advisor")) pi.setActiveTools(active.filter((t) => t !== "advisor"));
    return want;
  }

  // --- /advisor command ---
  pi.registerCommand(
    "advisor",
    createAdvisorCommand({
      pi,
      config,
      state,
      runAdvisorCall,
      getModels: () => availableModels,
      syncToolActive: syncAdvisorToolActive,
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    availableModels.length = 0;
    for (const m of ctx.modelRegistry.getAvailable()) {
      availableModels.push(`${m.provider}/${m.id}`);
    }
    syncAdvisorToolActive(ctx.model);
  });

  // --- Per-run reset + executor prompt injection ---
  pi.on("before_agent_start", async (event, ctx) => {
    state.startRun();
    const want = syncAdvisorToolActive(ctx.model);
    if (!want) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildExecutorAdvisorGuidance(config)}`,
    };
  });

  // --- Track mutations, advisor calls, and the optional strict gate ---
  pi.on("tool_call", (event, ctx) => {
    if (!advisorShouldBeActive(config, ctx?.model)) return;

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
  registerAdvisorTool();

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