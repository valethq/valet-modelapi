import type { InferenceChunk, InferenceRequest, ModelContent, ModelMessage } from "@valethq/sdk";
import type { Adapter } from "./adapter";
import type { EndpointConfig } from "./config";
import { type ResolvedModel, wireOptions } from "./models";
import { ReplayCache } from "./replay";
import type { SseEvent } from "./sse";
import { type BlobReader, deepMerge, parseArgs } from "./util";

type Block = Record<string, unknown>;
interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

const NO_CACHE_CONTROL = new Set(["thinking", "redacted_thinking"]);

async function blocks(content: ModelContent[], readBlob: BlobReader): Promise<Block[]> {
  const out: Block[] = [];
  for (const c of content) {
    if (c.type === "text") {
      if (c.text !== "") out.push({ type: "text", text: c.text });
    } else if (c.type === "image") {
      out.push({
        type: "image",
        source: { type: "base64", media_type: c.mime, data: await readBlob(c.blobId) },
      });
    } else out.push({ type: "tool_use", id: c.callId, name: c.name, input: c.input ?? {} });
  }
  return out;
}

const callIds = (content: ModelContent[]) =>
  content.flatMap((c) => (c.type === "tool-call" ? [c.callId] : []));

export function anthropicAdapter(ep: EndpointConfig, readBlob: BlobReader): Adapter {
  /** The assistant turn exactly as streamed (thinking, text, tool_use), keyed by its tool call ids. */
  const replay = new ReplayCache<Block[]>();

  async function wireMessage(m: ModelMessage): Promise<WireMessage | undefined> {
    if (m.role === "tool") {
      const content = await blocks(
        m.content.filter((c) => c.type !== "tool-call"),
        readBlob,
      );
      const result: Block = { type: "tool_result", tool_use_id: m.callId };
      if (content.length) result.content = content;
      if (m.isError) result.is_error = true;
      return { role: "user", content: [result] };
    }
    if (m.role === "assistant") {
      const ids = callIds(m.content);
      const cached = replay.get(ids);
      const toolUses = cached?.filter((b) => b.type === "tool_use").length;
      if (cached && toolUses === ids.length) return { role: "assistant", content: cached };
    }
    const content = await blocks(m.content, readBlob);
    return content.length ? { role: m.role, content } : undefined;
  }

  async function wireMessages(messages: ModelMessage[]): Promise<WireMessage[]> {
    const out: WireMessage[] = [];
    for (const m of messages) {
      const w = await wireMessage(m);
      if (!w) continue;
      const prev = out.at(-1);
      if (prev?.role === w.role) prev.content = [...prev.content, ...w.content];
      else out.push({ role: w.role, content: [...w.content] });
    }
    return out;
  }

  function markCache(messages: WireMessage[]): void {
    const last = messages.at(-1);
    const i = last ? last.content.length - 1 : -1;
    const block = last?.content[i];
    if (last && block && !NO_CACHE_CONTROL.has(block.type as string))
      last.content[i] = { ...block, cache_control: { type: "ephemeral" } };
  }

  async function build(req: InferenceRequest, model: ResolvedModel): Promise<Record<string, unknown>> {
    const cache = ep.promptCache !== false;
    const messages = await wireMessages(req.messages);
    if (cache) markCache(messages);
    const { effort, fast } = wireOptions(req, model);
    const body: Record<string, unknown> = {
      model: model.apiModel,
      max_tokens: req.maxOutputTokens ?? model.info.maxOutputTokens,
      stream: true,
      messages,
    };
    if (req.system)
      body.system = [
        { type: "text", text: req.system, ...(cache && { cache_control: { type: "ephemeral" } }) },
      ];
    if (req.tools.length)
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    return deepMerge(
      body,
      effort ? { output_config: { effort } } : undefined,
      fast ? { speed: "fast" } : undefined,
      ep.body,
      model.body,
    );
  }

  async function* parse(events: AsyncIterable<SseEvent>): AsyncGenerator<InferenceChunk> {
    const content = new Map<number, Block>();
    const json = new Map<number, string>();
    const calls: string[] = [];
    let inputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let stop: string | undefined;
    let refusal: string | undefined;

    const usage = (u: Record<string, number | undefined> | undefined) => {
      if (!u) return;
      if (u.input_tokens !== undefined) inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0);
      if (u.cache_read_input_tokens !== undefined) cacheReadTokens = u.cache_read_input_tokens;
      if (u.output_tokens !== undefined) outputTokens = u.output_tokens;
    };

    for await (const ev of events) {
      // biome-ignore lint/suspicious/noExplicitAny: wire JSON
      const d: any = JSON.parse(ev.data);
      switch (d.type) {
        case "message_start":
          usage(d.message?.usage);
          break;
        case "content_block_start": {
          const cb = { ...d.content_block } as Block;
          if (cb.type === "thinking") cb.signature ??= "";
          content.set(d.index, cb);
          if ("input" in cb) json.set(d.index, "");
          if (cb.type === "text" && cb.text) yield { type: "text-delta", text: cb.text as string };
          if (cb.type === "thinking" && cb.thinking)
            yield { type: "reasoning-delta", text: cb.thinking as string };
          break;
        }
        case "content_block_delta": {
          const cb = content.get(d.index);
          const delta = d.delta ?? {};
          if (!cb) break;
          if (delta.type === "text_delta") {
            cb.text = `${cb.text ?? ""}${delta.text}`;
            yield { type: "text-delta", text: delta.text };
          } else if (delta.type === "thinking_delta") {
            cb.thinking = `${cb.thinking ?? ""}${delta.thinking}`;
            if (delta.thinking) yield { type: "reasoning-delta", text: delta.thinking };
          } else if (delta.type === "signature_delta") {
            cb.signature = `${cb.signature ?? ""}${delta.signature}`;
          } else if (delta.type === "input_json_delta") {
            json.set(d.index, `${json.get(d.index) ?? ""}${delta.partial_json}`);
          }
          break;
        }
        case "content_block_stop": {
          const cb = content.get(d.index);
          const raw = json.get(d.index);
          if (!cb || raw === undefined) break;
          try {
            cb.input = parseArgs(raw);
          } catch {
            yield { type: "finish", reason: "error", error: `invalid tool input JSON for ${cb.name}` };
            return;
          }
          if (cb.type === "tool_use") {
            calls.push(cb.id as string);
            yield { type: "tool-call", callId: cb.id as string, name: cb.name as string, input: cb.input };
          }
          break;
        }
        case "message_delta":
          stop = d.delta?.stop_reason ?? stop;
          refusal = d.delta?.stop_details?.category ?? refusal;
          usage(d.usage);
          break;
        case "error":
          yield { type: "finish", reason: "error", error: d.error?.message ?? "stream error" };
          return;
      }
      if (d.type === "message_stop") break;
    }

    if (calls.length) {
      const turn = [...content.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, b]) => b)
        .filter((b) => !(b.type === "text" && !b.text));
      replay.set(calls, turn);
    }
    yield { type: "usage", inputTokens, outputTokens, cacheReadTokens };
    if (stop === undefined) yield { type: "finish", reason: "error", error: "stream ended early" };
    else if (stop === "tool_use") yield { type: "finish", reason: "tool-calls" };
    else if (stop === "max_tokens" || stop === "model_context_window_exceeded")
      yield { type: "finish", reason: "length" };
    else if (stop === "refusal")
      yield { type: "finish", reason: "error", error: `refused${refusal ? ` (${refusal})` : ""}` };
    else yield { type: "finish", reason: calls.length ? "tool-calls" : "stop" };
  }

  return { path: "/messages", build, parse };
}
