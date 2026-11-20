import type { InferenceRequest, ModelInfo } from "@valethq/sdk";
import {
  type CustomModel,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  type EndpointConfig,
  type ModelConfig,
} from "./config";
import { apiHeaders, apiUrl, type Fetch, send } from "./http";

export interface ResolvedModel {
  info: ModelInfo;
  /** The model id sent to the API. */
  apiModel: string;
  body?: Record<string, unknown>;
}

export function toModelInfo(m: ModelConfig): ModelInfo {
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    input: m.input ?? ["text"],
    reasoning: m.reasoning ?? (m.efforts?.length ?? 0) > 0,
    ...(m.efforts?.length ? { efforts: m.efforts } : {}),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    ...(m.fast ? { fast: true } : {}),
    ...(m.fastByDefault ? { fastByDefault: true } : {}),
  };
}

function toResolved(m: ModelConfig): ResolvedModel {
  return { apiModel: m.id, info: toModelInfo(m), ...(m.body && { body: m.body }) };
}

/** Effort and fast mode from the request, falling back to the model's defaults. */
export function wireOptions(req: InferenceRequest, model: ResolvedModel): { effort?: string; fast: boolean } {
  const effort = req.effort ?? model.info.defaultEffort;
  const fast = model.info.fast === true && (req.fast ?? model.info.fastByDefault) === true;
  return { ...(effort !== undefined ? { effort } : {}), fast };
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
  custom: () => CustomModel[] = () => [],
) {
  let cache: { at: number; ttl: number; models: ResolvedModel[] } | undefined;

  async function discover(): Promise<ResolvedModel[]> {
    const url = apiUrl(ep, ep.api === "anthropic" ? "/models?limit=1000" : "/models");
    const headers = apiHeaders(ep, await apiKey());
    const res = await send(doFetch, url, { headers, signal: AbortSignal.timeout(15_000) }, 0);
    const body = (await res.json()) as { data?: ListedModel[] };
    return (body.data ?? [])
      .filter((m) => typeof m.id === "string")
      .map((m) => toResolved(fromListing(ep, m)));
  }

  /** Custom models are appended; one that shares an id with a listed model is skipped. */
  async function all(): Promise<ResolvedModel[]> {
    const listed = await listedModels();
    const seen = new Set(listed.map((m) => m.info.id));
    return [
      ...listed,
      ...custom()
        .filter((m) => !seen.has(m.id))
        .map(toResolved),
    ];
  }

  async function listedModels(): Promise<ResolvedModel[]> {
    // An empty list means unset (v3's "empty clears"), so discovery still runs.
    if (ep.models?.length) return ep.models.map(toResolved);
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
    return hit ?? { apiModel: id, info: toModelInfo({ id }) };
  }

  return { list: async () => (await all()).map((m) => m.info), resolve };
}
