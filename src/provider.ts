import type { InferenceChunk, InferenceRequest, Logger, ModelProvider, UtilityModel } from "@valethq/sdk";
import type { Adapter } from "./adapter";
import { anthropicAdapter } from "./anthropic";
import type { EndpointConfig } from "./config";
import { apiHeaders, apiUrl, type Fetch, send } from "./http";
import { modelCatalog } from "./models";
import { openaiAdapter } from "./openai";
import { readSse } from "./sse";
import type { BlobReader } from "./util";

export interface ProviderDeps {
  fetch: Fetch;
  apiKey(name: string): Promise<string | undefined>;
  readBlob: BlobReader;
  log: Logger;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createProvider(ep: EndpointConfig, deps: ProviderDeps): ModelProvider {
  const adapter: Adapter =
    ep.api === "anthropic" ? anthropicAdapter(ep, deps.readBlob) : openaiAdapter(ep, deps.readBlob);
  const apiKey = () => (ep.apiKeySecret ? deps.apiKey(ep.apiKeySecret) : Promise.resolve(undefined));
  const catalog = modelCatalog(ep, deps.fetch, apiKey, deps.log.warn.bind(deps.log));

  async function* stream(req: InferenceRequest, signal: AbortSignal): AsyncGenerator<InferenceChunk> {
    try {
      const model = await catalog.resolve(req.model);
      const body = await adapter.build(req, model);
      const res = await send(
        deps.fetch,
        apiUrl(ep, adapter.path),
        {
          method: "POST",
          headers: { ...apiHeaders(ep, await apiKey()), accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        },
        ep.retries ?? 2,
      );
      if (!res.body) throw new Error("response has no body");
      yield* adapter.parse(readSse(res.body));
    } catch (error) {
      if (signal.aborted) yield { type: "finish", reason: "cancelled" };
      else {
        deps.log.warn("request failed", { endpoint: ep.id, model: req.model, error: message(error) });
        yield { type: "finish", reason: "error", error: message(error) };
      }
    }
  }

  const utilityId = () => ep.utilityModel?.trim() || undefined;
  const utility: UtilityModel = {
    model: utilityId,
    async complete(req, signal) {
      const model = utilityId();
      if (!model) throw new Error("no utility model is configured");
      let text = "";
      const chunks = stream(
        {
          model,
          system: req.system,
          messages: [{ role: "user", content: [{ type: "text", text: req.prompt }] }],
          tools: [],
          ...(req.maxOutputTokens && { maxOutputTokens: req.maxOutputTokens }),
          meta: { sessionId: "", runId: "" },
        },
        signal,
      );
      for await (const c of chunks) {
        if (c.type === "text-delta") text += c.text;
        if (c.type === "finish" && c.reason !== "stop" && c.reason !== "length")
          throw new Error(c.error ?? `utility call ${c.reason}`);
      }
      return text.trim();
    },
  };

  return {
    kind: "model",
    id: ep.id,
    label: ep.label ?? ep.id,
    listModels: catalog.list,
    utility,
    stream,
  };
}
