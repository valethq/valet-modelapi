import type { InferenceChunk, InferenceRequest, ModelMessage, ModelProvider } from "@valethq/sdk";
import type { EndpointConfig } from "../src/config";
import { createProvider } from "../src/provider";

export function provider(ep: Partial<EndpointConfig> & Pick<EndpointConfig, "api" | "baseUrl">) {
  const logs: { msg: string; data?: Record<string, unknown> }[] = [];
  const log = (msg: string, data?: Record<string, unknown>) => void logs.push({ msg, data });
  const p = createProvider(
    { id: "test", retries: 0, ...ep },
    {
      fetch: (url, init) => fetch(url, init),
      apiKey: async (name) => (name === "key" ? "sk-test" : undefined),
      readBlob: async (id) => Buffer.from(`bytes-of-${id}`).toString("base64"),
      log: { debug: log, info: log, warn: log, error: log },
    },
  );
  return { p: p as ModelProvider, logs };
}

export function request(messages: ModelMessage[], extra: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    model: "m1",
    system: "be brief",
    messages,
    tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object" } }],
    meta: { sessionId: "s1", runId: "r1" },
    ...extra,
  };
}

export async function collect(
  it: AsyncIterable<InferenceChunk>,
  onChunk?: (c: InferenceChunk) => void,
): Promise<InferenceChunk[]> {
  const out: InferenceChunk[] = [];
  for await (const c of it) {
    out.push(c);
    onChunk?.(c);
  }
  return out;
}

export const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
