import { readFileSync } from "node:fs";

type CodexVersionPolicy = {
  minimum: string;
  recommended: string;
  alpha: string;
};

const policy = readPolicy();

export const MINIMUM_COMPATIBLE_CODEX_CLI_VERSION = policy.minimum;
export const RECOMMENDED_CODEX_CLI_VERSION = policy.recommended;
export const NEXT_CODEX_CLI_CHANNEL = policy.alpha;

function readPolicy(): CodexVersionPolicy {
  const parsed = JSON.parse(readFileSync(new URL("../codex-versions.json", import.meta.url), "utf8")) as Partial<CodexVersionPolicy>;
  if (![parsed.minimum, parsed.recommended, parsed.alpha].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("codex-versions.json is invalid.");
  }
  return parsed as CodexVersionPolicy;
}
