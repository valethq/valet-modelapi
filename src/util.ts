import { randomUUID } from "node:crypto";

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Plain objects merge recursively; anything else in `extra` replaces. */
export function deepMerge(
  base: Record<string, unknown>,
  ...extras: (Record<string, unknown> | undefined)[]
): Record<string, unknown> {
  const out = { ...base };
  for (const extra of extras) {
    if (!extra) continue;
    for (const [k, v] of Object.entries(extra)) {
      const cur = out[k];
      out[k] = isPlain(cur) && isPlain(v) ? deepMerge(cur, v) : v;
    }
  }
  return out;
}

/** Tool input JSON; empty means no arguments. Throws on invalid JSON. */
export function parseArgs(raw: string): unknown {
  return raw.trim() === "" ? {} : JSON.parse(raw);
}

export const newCallId = () => `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;

export type BlobReader = (blobId: string) => Promise<string>;
