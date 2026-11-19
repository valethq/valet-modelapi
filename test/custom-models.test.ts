import { expect, test } from "bun:test";
import type { EndpointConfig } from "../src/config";
import { createProvider } from "../src/provider";

const ep: EndpointConfig = {
  id: "e1",
  api: "openai",
  baseUrl: "http://unused",
  models: [{ id: "a", name: "A" }],
  customModels: [
    { id: "a", name: "Dup" },
    { id: "mine", name: "Mine" },
  ],
};

test("listModels appends custom models after the configured ones and skips duplicate ids", async () => {
  const noop = () => {};
  const p = createProvider(ep, {
    fetch: (url, init) => fetch(url, init),
    apiKey: async () => undefined,
    readBlob: async () => "",
    log: { debug: noop, info: noop, warn: noop, error: noop },
  });
  expect((await p.listModels()).map((m) => [m.id, m.name])).toEqual([
    ["a", "A"],
    ["mine", "Mine"],
  ]);
});
