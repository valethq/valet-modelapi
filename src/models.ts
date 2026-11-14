import type { ModelInfo } from "@valethq/sdk";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, type EndpointConfig, type ModelConfig } from "./config";
import { apiHeaders, apiUrl, type Fetch, send } from "./http";

export interface ResolvedModel {
  info: ModelInfo;
  /** The model id sent to the API, without the effort suffix. */
  apiModel: string;
  effort?: string;
  body?: Record<string, unknown>;
}

function baseInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    input: m.input ?? ["text"],
    reasoning: m.reasoning ?? (m.efforts?.length ?? 0) > 0,
  };
}

function toInfos(m: ModelConfig): ResolvedModel[] {
  const info = baseInfo(m);
  const base = { apiModel: m.id, ...(m.body && { body: m.body }) };
  if (!m.efforts?.length) return [{ ...base, info }];
  return m.efforts.map((effort) => ({
    ...base,
    effort,
    info: { ...info, id: `${m.id}-${effort}`, name: `${info.name} (${effort})` },
  }));
}

interface ListedModel {
  id: string;
  display_name?: string;
  name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
  context_length?: number;
  context_window?: number;
}

function fromListing(ep: EndpointConfig, m: ListedModel): ModelConfig {
  const ctx = m.max_input_tokens ?? m.context_length ?? m.context_window;
  return {
    id: m.id,
    name: m.display_name ?? m.name ?? m.id,
    ...(ctx && { contextWindow: ctx }),
    ...(m.max_tokens && { maxOutputTokens: m.max_tokens }),
    input: ep.api === "anthropic" ? ["text", "image"] : ["text"],
  };
}

const TTL_OK = 10 * 60_000;
const TTL_FAIL = 60_000;

/** Configured models, or the endpoint's GET /models listing cached for 10 minutes. */
export function modelCatalog(
  ep: EndpointConfig,
  doFetch: Fetch,
  apiKey: () => Promise<string | undefined>,
  warn: (msg: string, data: Record<string, unknown>) => void,
) {
  let cache: { at: number; ttl: number; models: ResolvedModel[] } | undefined;

  async function discover(): Promise<ResolvedModel[]> {
    const url = apiUrl(ep, ep.api === "anthropic" ? "/models?limit=1000" : "/models");
    const headers = apiHeaders(ep, await apiKey());
    const res = await send(doFetch, url, { headers, signal: AbortSignal.timeout(15_000) }, 0);
    const body = (await res.json()) as { data?: ListedModel[] };
    return (body.data ?? [])
      .filter((m) => typeof m.id === "string")
      .flatMap((m) => toInfos(fromListing(ep, m)));
  }

  async function all(): Promise<ResolvedModel[]> {
    if (ep.models) return ep.models.flatMap(toInfos);
    if (cache && Date.now() - cache.at < cache.ttl) return cache.models;
    try {
      cache = { at: Date.now(), ttl: TTL_OK, models: await discover() };
    } catch (error) {
      warn("model discovery failed", { endpoint: ep.id, error: String(error) });
      cache = { at: Date.now(), ttl: TTL_FAIL, models: cache?.models ?? [] };
    }
    return cache.models;
  }

  /** Picker id -> API model. Unknown ids pass through, so a model missing from the listing still runs. */
  async function resolve(id: string): Promise<ResolvedModel> {
    const hit = (await all()).find((m) => m.info.id === id);
    return hit ?? { apiModel: id, info: baseInfo({ id }) };
  }

  return { list: async () => (await all()).map((m) => m.info), resolve };
}
