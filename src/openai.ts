import type { InferenceChunk, InferenceRequest, ModelContent, ModelMessage } from "@valethq/sdk";
import type { Adapter } from "./adapter";
import type { EndpointConfig } from "./config";
import type { ResolvedModel } from "./models";
import { ReplayCache } from "./replay";
import type { SseEvent } from "./sse";
import { type BlobReader, deepMerge, newCallId, parseArgs } from "./util";

type Wire = Record<string, unknown>;
interface Reasoning {
  field: string;
  text: string;
}

const textOf = (content: ModelContent[]) =>
  content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");

export function openaiAdapter(ep: EndpointConfig, readBlob: BlobReader): Adapter {
  /** reasoning_content / reasoning as the server sent it, for servers that want it back on tool turns. */
  const replay = new ReplayCache<Reasoning>();

  const imagePart = async (c: Extract<ModelContent, { type: "image" }>) => ({
    type: "image_url",
    image_url: { url: `data:${c.mime};base64,${await readBlob(c.blobId)}` },
  });

  async function userContent(content: ModelContent[]): Promise<string | Wire[]> {
    if (!content.some((c) => c.type === "image")) return textOf(content);
    const parts: Wire[] = [];
    for (const c of content) {
      if (c.type === "text") parts.push({ type: "text", text: c.text });
      else if (c.type === "image") parts.push(await imagePart(c));
    }
    return parts;
  }

  function assistant(m: Extract<ModelMessage, { role: "assistant" }>): Wire | undefined {
    const text = textOf(m.content);
    const calls = m.content.flatMap((c) => (c.type === "tool-call" ? [c] : []));
    if (!calls.length) return text ? { role: "assistant", content: text } : undefined;
    const msg: Wire = {
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.callId,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      })),
    };
    const r = replay.get(calls.map((c) => c.callId));
    if (r) msg[r.field] = r.text;
    return msg;
  }

  async function wireMessages(system: string, messages: ModelMessage[]): Promise<Wire[]> {
    const out: Wire[] = system ? [{ role: "system", content: system }] : [];
    let images: Wire[] = [];
    const flushImages = () => {
      if (!images.length) return;
      out.push({
        role: "user",
        content: [{ type: "text", text: "Images returned by the tool calls above:" }, ...images],
      });
      images = [];
    };
    for (const m of messages) {
      if (m.role !== "tool") flushImages();
      if (m.role === "user") out.push({ role: "user", content: await userContent(m.content) });
      else if (m.role === "assistant") {
        const w = assistant(m);
        if (w) out.push(w);
      } else {
        const text = textOf(m.content) || "(no output)";
        out.push({ role: "tool", tool_call_id: m.callId, content: m.isError ? `Error: ${text}` : text });
        for (const c of m.content) if (c.type === "image") images.push(await imagePart(c));
      }
    }
    flushImages();
    return out;
  }

  async function build(req: InferenceRequest, model: ResolvedModel): Promise<Record<string, unknown>> {
    const effort = model.effort ?? (req.reasoning && req.reasoning !== "off" ? req.reasoning : undefined);
    const body: Record<string, unknown> = {
      model: model.apiModel,
      messages: await wireMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length)
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    return deepMerge(body, effort ? { reasoning_effort: effort } : undefined, ep.body, model.body);
  }

  async function* parse(events: AsyncIterable<SseEvent>): AsyncGenerator<InferenceChunk> {
    const calls: { id: string; name: string; args: string }[] = [];
    const reasoning: Reasoning = { field: "reasoning_content", text: "" };
    let finish: string | undefined;
    let done = false;
    let usage: { prompt_tokens?: number; completion_tokens?: number; cached?: number } | undefined;

    for await (const ev of events) {
      if (ev.data === "[DONE]") {
        done = true;
        break;
      }
      // biome-ignore lint/suspicious/noExplicitAny: wire JSON
      const d: any = JSON.parse(ev.data);
      if (d.error) {
        const msg = typeof d.error === "string" ? d.error : (d.error.message ?? JSON.stringify(d.error));
        yield { type: "finish", reason: "error", error: msg };
        return;
      }
      if (d.usage)
        usage = { ...d.usage, cached: d.usage.prompt_tokens_details?.cached_tokens ?? d.usage.cached_tokens };
      const choice = d.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content)
        yield { type: "text-delta", text: delta.content };
      for (const field of ["reasoning_content", "reasoning"]) {
        const r = delta[field];
        if (typeof r !== "string" || !r) continue;
        reasoning.field = field;
        reasoning.text += r;
        yield { type: "reasoning-delta", text: r };
        break;
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = typeof tc.index === "number" ? tc.index : calls.length;
        calls[i] ??= { id: "", name: "", args: "" };
        const slot = calls[i];
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name ||= tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const made = calls.filter(Boolean);
    const ids: string[] = [];
    for (const c of made) {
      let input: unknown;
      try {
        input = parseArgs(c.args);
      } catch {
        yield { type: "finish", reason: "error", error: `invalid tool input JSON for ${c.name}` };
        return;
      }
      const callId = c.id || newCallId();
      ids.push(callId);
      yield { type: "tool-call", callId, name: c.name, input };
    }
    if (ids.length && reasoning.text) replay.set(ids, { ...reasoning });
    if (usage) {
      const cached = usage.cached ?? 0;
      yield {
        type: "usage",
        inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: cached,
      };
    }
    if (!done && !finish) yield { type: "finish", reason: "error", error: "stream ended early" };
    else if (ids.length) yield { type: "finish", reason: "tool-calls" };
    else if (finish === "length") yield { type: "finish", reason: "length" };
    else if (finish === "content_filter")
      yield { type: "finish", reason: "error", error: "content filtered" };
    else yield { type: "finish", reason: "stop" };
  }

  return { path: "/chat/completions", build, parse };
}
