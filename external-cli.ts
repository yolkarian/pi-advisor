/**
 * External CLI advisor backend (optional).
 *
 * For users who are already logged into a CLI such as Claude CLI or Codex CLI and do
 * not want to configure a second API key inside Pi. The extension builds the curated
 * context, pipes it to the CLI's stdin, and parses the advisor output from stdout.
 *
 * This backend does not get structured usage back from the CLI, so usage is reported
 * as zero and cost tracking falls back to whatever the CLI prints (ignored here).
 */

import { spawn } from "node:child_process";
import type { AdvisorConfig } from "./config.ts";
import type { AdvisorResponse } from "./adapter.ts";

const CLI_TIMEOUT_MS = 120_000;

/** Render the input we pipe to the external CLI: system prompt + the user context. */
function renderCliInput(system: string, transcriptText: string, resume: boolean): string {
  const resumeNote = resume
    ? "\n\n(This is part of an ongoing advisor review session; build on any prior guidance you gave.)"
    : "";
  return `${system}\n\n---\n\nYou are advising a coding agent. Below is the curated session context. Respond with the structured advisor output only.\n\n${transcriptText}${resumeNote}\n`;
}

function collectOutput(child: { stdout: { on: (e: string, cb: (d: Buffer) => void) => void }; stderr: { on: (e: string, cb: (d: Buffer) => void) => void } }): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

/**
 * Spawn the configured external CLI, feed it the advisor context on stdin, and return
 * stdout as the advisor guidance. Throws on timeout, non-zero exit with no stdout, or
 * spawn failure.
 */
export function callExternalCliAdvisor(
  config: AdvisorConfig,
  system: string,
  transcriptText: string,
  signal: AbortSignal | undefined,
): Promise<AdvisorResponse> {
  return new Promise((resolve, reject) => {
    const { command, args, resume } = config.externalCli;
    if (!command) {
      reject(new Error("external CLI backend enabled but no command configured (set externalCli.command)."));
      return;
    }

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const collected = collectOutput(child);
    const startedAt = Date.now();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
      reject(new Error(`external CLI "${command}" timed out after ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      reject(new Error("advisor call was aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn external CLI "${command}": ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);

      const stdout = collected.stdout.trim();
      const stderr = collected.stderr.trim();
      if (!stdout && stderr) {
        reject(new Error(`external CLI "${command}" failed (exit ${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      if (!stdout) {
        reject(new Error(`external CLI "${command}" produced no output (exit ${code}).`));
        return;
      }
      resolve({
        text: stdout,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        elapsedMs: Date.now() - startedAt,
        model: `cli:${command}`,
      });
    });

    // Pipe the advisor context in and close stdin so the CLI can process and exit.
    try {
      child.stdin.write(renderCliInput(system, transcriptText, resume));
      child.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to write to external CLI "${command}": ${(err as Error).message}`));
    }
  });
}