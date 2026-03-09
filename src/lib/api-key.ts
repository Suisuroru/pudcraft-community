import { randomBytes, createHash } from "crypto";

const API_KEY_PREFIX = "pdc_";
const API_KEY_BYTES = 32;

/** Generate a new API key. Returns { raw, hash } — raw is shown once, hash is stored. */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = API_KEY_PREFIX + randomBytes(API_KEY_BYTES).toString("hex");
  const hash = hashApiKey(raw);
  return { raw, hash };
}

/** Hash an API key for storage/comparison. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
