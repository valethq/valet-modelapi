import type { InferenceChunk, InferenceRequest } from "@valethq/sdk";
import type { ResolvedModel } from "./models";
import type { SseEvent } from "./sse";

/** One wire protocol: how a request is encoded and how its SSE stream maps to InferenceChunks. */
export interface Adapter {
  path: string;
  build(req: InferenceRequest, model: ResolvedModel): Promise<Record<string, unknown>>;
  parse(events: AsyncIterable<SseEvent>): AsyncGenerator<InferenceChunk>;
}
