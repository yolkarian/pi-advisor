/**
 * Secret redaction for the advisor context.
 *
 * The advisor transcript is sent to an external model, so anything that looks like
 * a credential is scrubbed first. This is defense-in-depth, not a security boundary:
 * the patterns cover common token shapes, PEM blocks, and `key=value` style secrets,
 * but novel formats can still slip through. The strongest protection is never reading
 * secret files into the transcript in the first place (see `transcript.ts`).
 */

type SecretPattern = {
  /** Unique id, used for debug counts if needed. */
  id: string;
  regex: RegExp;
};

// Patterns are intentionally greedy and global. Order matters only for readability;
// each runs over the full text independently.
const SECRET_PATTERNS: SecretPattern[] = [
  { id: "openai-key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { id: "anthropic-key", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "github-pat", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { id: "github-fine-pat", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { id: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { id: "aws-secret", regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
  { id: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { id: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: "pem-private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "pem-certificate", regex: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g },
  { id: "authorization-bearer", regex: /[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._-]+/g },
  { id: "authorization-basic", regex: /[Aa]uthorization:\s*Basic\s+[A-Za-z0-9._=/+-]+/g },
  { id: "x-api-key", regex: /x-api-key:\s*[A-Za-z0-9._-]+/gi },
  { id: "password-assign", regex: /(?<=\bpassword\s*[:=]\s*)[^\s,;"']+/gi },
  { id: "token-assign", regex: /(?<=\b(?:access_token|refresh_token|api_key|apikey|secret|client_secret)\s*[:=]\s*)[^\s,;"']+/gi },
];

/** Replace every secret-shaped substring with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  let output = text;
  for (const { regex } of SECRET_PATTERNS) {
    output = output.replace(regex, "[REDACTED]");
  }
  return output;
}

/** True when a path looks like a secrets file that should never be sent verbatim. */
export function looksLikeSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".env") || lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  if (lower.endsWith(".p12") || lower.endsWith(".pfx") || lower.endsWith(".keystore")) return true;
  // .env.* variants: .env.local, .env.production, but NOT .environment.ts
  if (/\.env(\.[\w-]+)?$/.test(lower)) return true;
  const base = lower.split("/").pop() ?? lower;
  return base === "credentials.json" || base === "secrets.json" || base === "auth.json";
}

/**
 * Summarize a secret file for the advisor without sending its contents.
 * Returns a short note naming the file and, for `.env`, the variable keys only.
 */
export function summarizeSecretFile(path: string, contents: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".env") || /\.env(\.[\w-]+)?$/.test(lower)) {
    const keys = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=")[0]?.trim() ?? "")
      .filter((key) => key.length > 0);
    return `.env detected at ${path}. Contents redacted. Keys present: ${keys.join(", ") || "(none)"}.`;
  }
  return `Secret file detected at ${path}. Contents redacted.`;
}