const REDACTED_SECRET = "[redacted:secret]";

export function redactPotentialSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, REDACTED_SECRET)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED_SECRET)
    .replace(
      /(\bAuthorization\s*:\s*Bearer\s+)([^\s"']+)/gi,
      `$1${REDACTED_SECRET}`,
    )
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|bearer[_-]?token|password|secret)\b\s*(?::\s*|=\s*))(["']?)([^"'\s]+)\2/gi,
      `$1$2${REDACTED_SECRET}$2`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret)=)([^&#\s]+)/gi,
      `$1${REDACTED_SECRET}`,
    )
    .replace(
      /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
      `$1$2:${REDACTED_SECRET}@`,
    );
}
