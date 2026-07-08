/**
 * External CLI advisor backend (optional): consult a separate `pi` invocation.
 *
 * Spawns `pi --no-extensions --no-tools --no-session --mode json -p` with the advisor
 * system prompt and the curated context as the prompt, then parses the JSON event
 * stream for the advisor's final text.
 *
 * Why those flags:
 * - `--no-tools` keeps the advisor tool-less: it can only return text, never edit files
 *   or run commands (preserving the advisor boundary even though it runs in a child
 *   process).
 * - `--no-extensions` prevents this extension (and others) from loading inside the
 *   spawned pi. Without it, the globally installed pi-advisor would re-enable the
 *   `advisor` tool and re-inject executor guidance, causing recursion and noise.
 * - `--no-session` makes the call ephemeral (no session file written).
 * - `--mode json -p` gives a parseable, non-interactive event stream.
 *
 * The advisor model is the configured `provider/model` with `reasoning` effort — the
 * same config as the default pi-ai backend, here driven through a child `pi` instead of
 * an in-process completion. This backend is opt-in (`mode: "external-cli"`); the default
 * path stays in-process.
 *
 * Because `--no-extensions` is used, only built-in model providers are available to the
 * spawned advisor. For an extension-provided advisor model (e.g. a custom provider),
 * use the default `pi-ai` backend instead.
 */

import { spawn } from "node:child_process";
import type { AdvisorConfig } from "../config.ts";
import type { AdvisorResponse } from "./types.ts";

const CLI_TIMEOUT_MS = 120_000;

type JsonEvent = {
  type: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input?: number; output?: number; totalTokens?: number };
    stopReason?: string;
    errorMessage?: string;
  };
};

function parseJsonEvent(line: string): JsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as JsonEvent;
  } catch {
    return null;
  }
}

/**
 * Spawn a tool-less `pi` as the advisor, feed it the curated context as the prompt, and
 * resolve with the advisor's final text + usage. Throws a human-readable error on
 * timeout, abort, spawn failure, or when no advisor text is produced.
 */
export function callExternalCliAdvisor(
  config: AdvisorConfig,
  system: string,
  transcriptText: string,
  signal: AbortSignal | undefined,
): Promise<AdvisorResponse> {
  return new Promise((resolve, reject) => {
    const command = config.externalCli.command || "pi";
    const prompt =
      "You are advising a coding agent. Below is the curated session context. " +
      "Respond with the structured advisor output only.\n\n" +
      transcriptText;

    const args: string[] = [
      "--no-extensions",
      "--no-tools",
      "--no-session",
      "--mode",
      "json",
      "-p",
      "--model",
      `${config.provider}/${config.model}`,
      "--thinking",
      config.reasoning,
      "--system-prompt",
      system,
      ...config.externalCli.args,
      prompt,
    ];

    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5_000);
        reject(new Error(`external pi advisor timed out after ${CLI_TIMEOUT_MS}ms`));
      });
    }, CLI_TIMEOUT_MS);

    const onAbort = () => {
      finish(() => {
        child.kill("SIGTERM");
        reject(new Error("advisor call was aborted"));
      });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      finish(() => {
        reject(
          new Error(
            `failed to spawn "${command}" (is pi on PATH? set externalCli.command to a full path): ${err.message}`,
          ),
        );
      });
    });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      finish(() => {
        const events = stdout
          .split("\n")
          .map(parseJsonEvent)
          .filter((e): e is JsonEvent => e !== null);
        const assistantEnds = events.filter(
          (e) => e.type === "message_end" && e.message?.role === "assistant",
        );

        if (assistantEnds.length === 0) {
          const errTail = stderr.trim().slice(0, 500);
          reject(
            new Error(
              `external pi advisor produced no assistant output (exit ${code})${
                errTail ? `: ${errTail}` : ""
              }`,
            ),
          );
          return;
        }

        const last = assistantEnds[assistantEnds.length - 1].message!;
        if (last.stopReason === "error" || last.stopReason === "aborted") {
          reject(new Error(last.errorMessage || `external pi advisor stopped (${last.stopReason})`));
          return;
        }

        const text = (last.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text!)
          .join("\n")
          .trim();

        if (!text) {
          reject(new Error("external pi advisor returned no text"));
          return;
        }

        const usage = last.usage;
        resolve({
          text,
          usage: {
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
          },
          elapsedMs: Date.now() - startedAt,
          model: `${config.provider}/${config.model}`,
        });
      });
    });
  });
}