import { type Disposable, definePlugin, type PluginContext } from "@valethq/sdk";
import type { EndpointConfig, ModelApiConfig } from "./config";
import { createProvider } from "./provider";
import { customModels, provideSettings } from "./settings";

function checkEndpoints(endpoints: EndpointConfig[]): void {
  const seen = new Set<string>();
  for (const ep of endpoints) {
    if (!ep.id.trim()) throw new Error("endpoint id must not be empty");
    if (seen.has(ep.id)) throw new Error(`duplicate endpoint id "${ep.id}"`);
    seen.add(ep.id);
  }
}

function provideAll(ctx: PluginContext<ModelApiConfig>, config: ModelApiConfig | undefined): Disposable[] {
  const endpoints = config?.endpoints ?? [];
  checkEndpoints(endpoints);
  const deps = {
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    apiKey: async (name: string) => (await ctx.secrets.get(name))?.trim(),
    readBlob: async (id: string) =>
      Buffer.from(await Bun.file(ctx.store.blobs.path(id)).arrayBuffer()).toString("base64"),
    log: ctx.log,
    customModels: (ep: EndpointConfig) => customModels(ctx, ep),
  };
  return endpoints.flatMap((ep) => [
    ctx.scopes.provide("inference", createProvider(ep, deps), { key: ep.id }),
    provideSettings(ctx, ep),
  ]);
}

export default definePlugin<ModelApiConfig>({
  activate(ctx) {
    ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
    let provided = provideAll(ctx, ctx.config);
    ctx.onConfigChange((next) => {
      checkEndpoints(next?.endpoints ?? []);
      for (const d of provided) d.dispose();
      provided = provideAll(ctx, next);
    });
  },
});
