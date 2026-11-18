import { expect, test } from "bun:test";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
import type { EndpointConfig, ModelApiConfig } from "../src/config";
import { createProvider } from "../src/provider";
import { customModels, provideSettings } from "../src/settings";

const ep: EndpointConfig = {
  id: "e1",
  api: "openai",
  baseUrl: "http://unused",
  models: [{ id: "a", name: "A" }],
};

function fakeCtx() {
  const kv = new Map<string, unknown>();
  const panels: { key?: string; impl: SettingsPanel }[] = [];
  const ctx = {
    storage: { kv: { get: (k: string) => kv.get(k), set: (k: string, v: unknown) => void kv.set(k, v) } },
    scopes: {
      provide: (_s: string, impl: SettingsPanel, opts?: { key?: string }) => {
        panels.push({ key: opts?.key, impl });
        return { dispose() {} };
      },
    },
  } as unknown as PluginContext<ModelApiConfig>;
  return { ctx, panels };
}

test("the panel stores custom models per endpoint and rejects entries without a model name", async () => {
  const { ctx, panels } = fakeCtx();
  provideSettings(ctx, ep);
  const panel = panels[0]?.impl;
  expect(panels[0]?.key).toBe("valet-modelapi:e1");
  await panel?.set?.({
    customModels: [
      { id: " mine ", name: "Mine" },
      { id: "bare", name: "" },
    ],
  });
  expect(customModels(ctx, ep)).toEqual([{ id: "mine", name: "Mine" }, { id: "bare" }]);
  expect(customModels(ctx, { ...ep, id: "e2" })).toEqual([]);
  expect(() => panel?.set?.({ customModels: [{ id: "" }] })).toThrow("customModels");
});

test("listModels appends custom models after the configured ones and skips duplicate ids", async () => {
  const noop = () => {};
  const p = createProvider(ep, {
    fetch: (url, init) => fetch(url, init),
    apiKey: async () => undefined,
    readBlob: async () => "",
    log: { debug: noop, info: noop, warn: noop, error: noop },
    customModels: () => [
      { id: "a", name: "Dup" },
      { id: "mine", name: "Mine" },
    ],
  });
  expect((await p.listModels()).map((m) => [m.id, m.name])).toEqual([
    ["a", "A"],
    ["mine", "Mine"],
  ]);
});
