import { ANTHROPIC_VERSION, type EndpointConfig } from "./config";

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export function apiUrl(ep: EndpointConfig, path: string): string {
  return `${ep.baseUrl.replace(/\/+$/, "")}${path}`;
}

export function apiHeaders(ep: EndpointConfig, key: string | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (ep.api === "anthropic") h["anthropic-version"] = ANTHROPIC_VERSION;
  if (key) {
    const auth = ep.auth ?? (ep.api === "anthropic" ? "x-api-key" : "bearer");
    if (auth === "bearer") h.authorization = `Bearer ${key}`;
    else h["x-api-key"] = key;
  }
  return { ...h, ...ep.headers };
}

/** The provider's own message from an error body, else the raw text. */
export function errorText(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const msg = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
    if (msg) return `HTTP ${status}: ${msg}`;
  } catch {}
  return `HTTP ${status}: ${body.slice(0, 500) || "no body"}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

function backoff(res: Response | undefined, attempt: number): number {
  const ra = Number(res?.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10_000);
  return Math.min(500 * 3 ** attempt, 10_000);
}

/** Sends with retries on transient failures; throws ApiError for a final non-2xx. */
export async function send(
  doFetch: Fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  retries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await doFetch(url, init);
    } catch (error) {
      if (init.signal.aborted || attempt >= retries) throw error;
    }
    if (res?.ok) return res;
    if (res && (!RETRYABLE.has(res.status) || attempt >= retries))
      throw new ApiError(res.status, errorText(res.status, await res.text().catch(() => "")));
    await res?.body?.cancel().catch(() => {});
    await sleep(backoff(res, attempt), init.signal);
  }
}
