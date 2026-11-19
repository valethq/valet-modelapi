import { afterAll, expect, test } from "bun:test";
import type { ModelMessage } from "@valethq/sdk";
import { fakeServer, json, sse } from "./fake-server";
import { collect, provider, request, user } from "./helpers";

const srv = fakeServer();
afterAll(() => srv.stop());

const toolTurn = (id: string) => [
  {
    type: "message_start",
    message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 90 } },
  },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id, name: "echo", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "1}" } },
  { type: "content_block_stop", index: 2 },
  { type: "ping" },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

test("streams thinking, text, tool_use and usage; request shape", async () => {
  const { p } = provider({ api: "anthropic", baseUrl: srv.url, apiKeySecret: "key" });
  srv.reply(sse(toolTurn("tu1"), { named: true }));
  const out = await collect(p.stream(request([user("hello")]), new AbortController().signal));
  expect(out).toEqual([
    { type: "reasoning-delta", text: "hmm" },
    { type: "text-delta", text: "Let me" },
    { type: "tool-call", callId: "tu1", name: "echo", input: { a: 1 } },
    { type: "usage", inputTokens: 15, outputTokens: 42, cacheReadTokens: 90 },
    { type: "finish", reason: "tool-calls" },
  ]);
  const req = srv.requests.at(-1);
  expect(req?.path).toBe("/v1/messages");
  expect(req?.headers["x-api-key"]).toBe("sk-test");
  expect(req?.headers["anthropic-version"]).toBe("2023-06-01");
  expect(req?.body).toEqual({
    model: "m1",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
    ],
    tools: [{ name: "echo", description: "Echoes", input_schema: { type: "object" } }],
  });
});

test("replays the streamed turn verbatim and merges tool results into one user message", async () => {
  const { p } = provider({ api: "anthropic", baseUrl: srv.url, promptCache: false });
  srv.reply(sse(toolTurn("tu2")));
  await collect(p.stream(request([user("go")]), new AbortController().signal));
  const history: ModelMessage[] = [
    user("go"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me" },
        { type: "tool-call", callId: "tu2", name: "echo", input: { a: 1 } },
      ],
    },
    { role: "tool", callId: "tu2", content: [{ type: "text", text: "echo" }] },
    {
      role: "tool",
      callId: "other",
      isError: true,
      content: [{ type: "image", mime: "image/png", blobId: "b" }],
    },
  ];
  srv.reply(
    sse([
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
  );
  const out = await collect(p.stream(request(history), new AbortController().signal));
  expect(out.at(0)).toEqual({ type: "text-delta", text: "done" });
  expect(out.at(-1)).toEqual({ type: "finish", reason: "stop" });
  const body = srv.requests.at(-1)?.body;
  expect(body.system).toEqual([{ type: "text", text: "be brief" }]);
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "SIG" },
        { type: "text", text: "Let me" },
        { type: "tool_use", id: "tu2", name: "echo", input: { a: 1 } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "echo" }] },
        {
          type: "tool_result",
          tool_use_id: "other",
          is_error: true,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: Buffer.from("bytes-of-b").toString("base64"),
              },
            },
          ],
        },
      ],
    },
  ]);
});

test("effort and fast options go to output_config and speed, merged with endpoint body", async () => {
  const { p } = provider({
    api: "anthropic",
    baseUrl: srv.url,
    body: { thinking: { type: "adaptive", display: "summarized" }, output_config: { x: 1 } },
    models: [
      {
        id: "claude-opus-5-5",
        maxOutputTokens: 64000,
        efforts: ["low", "max"],
        fast: true,
      },
    ],
  });
  expect(await p.listModels()).toEqual([
    expect.objectContaining({
      id: "claude-opus-5-5",
      efforts: ["low", "max"],
      fast: true,
      reasoning: true,
    }),
  ]);
  srv.reply(
    sse([
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
  );
  const out = await collect(
    p.stream(
      request([user("q")], { model: "claude-opus-5-5", effort: "max", fast: true, tools: [] }),
      new AbortController().signal,
    ),
  );
  expect(out.at(-1)).toEqual({ type: "finish", reason: "length" });
  const body = srv.requests.at(-1)?.body;
  expect(body).toMatchObject({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "max", x: 1 },
    speed: "fast",
  });
  expect(body.tools).toBeUndefined();
});

test("refusal and error events become finish errors", async () => {
  const { p } = provider({ api: "anthropic", baseUrl: srv.url });
  srv.reply(
    sse([
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber" } } },
      { type: "message_stop" },
    ]),
  );
  expect((await collect(p.stream(request([user("q")]), new AbortController().signal))).at(-1)).toEqual({
    type: "finish",
    reason: "error",
    error: "refused (cyber)",
  });
  srv.reply(sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]));
  expect((await collect(p.stream(request([user("q")]), new AbortController().signal))).at(-1)).toEqual({
    type: "finish",
    reason: "error",
    error: "Overloaded",
  });
});

test("discovers models with context window and output cap; bearer auth option", async () => {
  const { p } = provider({ api: "anthropic", baseUrl: srv.url, apiKeySecret: "key", auth: "bearer" });
  srv.replyModels(
    json({
      data: [
        { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1e6, max_tokens: 128000 },
      ],
    }),
  );
  expect(await p.listModels()).toEqual([
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      contextWindow: 1e6,
      maxOutputTokens: 128000,
      input: ["text", "image"],
      reasoning: false,
    },
  ]);
  const req = srv.requests.at(-1);
  expect(req?.path).toBe("/v1/models?limit=1000");
  expect(req?.headers.authorization).toBe("Bearer sk-test");
  expect(req?.headers["x-api-key"]).toBeUndefined();
});
