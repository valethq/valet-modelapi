import { afterAll, expect, test } from "bun:test";
import type { ModelMessage } from "@valethq/sdk";
import { fakeServer, json, sse } from "./fake-server";
import { collect, provider, request, user } from "./helpers";

const srv = fakeServer();
afterAll(() => srv.stop());

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});

test("streams text, reasoning, split tool-call args and usage", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url, apiKeySecret: "key" });
  srv.reply(
    sse([
      chunk({ role: "assistant", reasoning_content: "think" }),
      chunk({ content: "Hi" }),
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"a"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
      chunk({}, "tool_calls"),
      {
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
      },
      "[DONE]",
    ]),
  );
  const out = await collect(p.stream(request([user("hello")]), new AbortController().signal));
  expect(out).toEqual([
    { type: "reasoning-delta", text: "think" },
    { type: "text-delta", text: "Hi" },
    { type: "tool-call", callId: "c1", name: "echo", input: { a: 1 } },
    { type: "usage", inputTokens: 40, outputTokens: 7, cacheReadTokens: 60 },
    { type: "finish", reason: "tool-calls" },
  ]);
  const req = srv.requests.at(-1);
  expect(req?.path).toBe("/v1/chat/completions");
  expect(req?.headers.authorization).toBe("Bearer sk-test");
  expect(req?.body).toMatchObject({
    model: "m1",
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ],
    tools: [
      { type: "function", function: { name: "echo", description: "Echoes", parameters: { type: "object" } } },
    ],
  });
});

test("encodes tool turns, replays reasoning_content and moves tool images to a user message", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url });
  srv.reply(
    sse([
      chunk({ reasoning_content: "plan" }),
      chunk({ tool_calls: [{ index: 0, id: "c9", function: { name: "echo", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]),
  );
  await collect(p.stream(request([user("go")]), new AbortController().signal));
  srv.reply(sse([chunk({ content: "ok" }, "stop"), "[DONE]"]));
  const history: ModelMessage[] = [
    user("go"),
    { role: "assistant", content: [{ type: "tool-call", callId: "c9", name: "echo", input: {} }] },
    {
      role: "tool",
      callId: "c9",
      isError: true,
      content: [
        { type: "text", text: "boom" },
        { type: "image", mime: "image/png", blobId: "b1" },
      ],
    },
  ];
  await collect(p.stream(request(history), new AbortController().signal));
  const msgs = srv.requests.at(-1)?.body.messages;
  expect(msgs.slice(1)).toEqual([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "plan",
      tool_calls: [{ id: "c9", type: "function", function: { name: "echo", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c9", content: "Error: boom" },
    {
      role: "user",
      content: [
        { type: "text", text: "Images returned by the tool calls above:" },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${Buffer.from("bytes-of-b1").toString("base64")}` },
        },
      ],
    },
  ]);
});

test("effort and fast options become reasoning_effort and service_tier; body merges in", async () => {
  const { p } = provider({
    api: "openai",
    baseUrl: srv.url,
    body: { temperature: 0.2, extra: { a: 1 } },
    models: [
      {
        id: "gpt-x",
        efforts: ["low", "high"],
        defaultEffort: "low",
        fast: true,
        body: { extra: { b: 2 } },
      },
    ],
  });
  expect(await p.listModels()).toEqual([
    expect.objectContaining({
      id: "gpt-x",
      reasoning: true,
      efforts: ["low", "high"],
      defaultEffort: "low",
      fast: true,
    }),
  ]);
  srv.reply(sse([chunk({ content: "x" }, "stop"), "[DONE]"]));
  await collect(
    p.stream(
      request([user("q")], { model: "gpt-x", effort: "high", fast: true }),
      new AbortController().signal,
    ),
  );
  expect(srv.requests.at(-1)?.body).toMatchObject({
    model: "gpt-x",
    reasoning_effort: "high",
    service_tier: "fast",
    temperature: 0.2,
    extra: { a: 1, b: 2 },
  });
});

test("HTTP errors become finish error with the provider's message", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url });
  srv.reply(json({ error: { message: "bad model" } }, 400));
  const out = await collect(p.stream(request([user("q")]), new AbortController().signal));
  expect(out).toEqual([{ type: "finish", reason: "error", error: "HTTP 400: bad model" }]);
});

test("retries 429 then succeeds", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url, retries: 1 });
  srv.reply(
    () => new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }),
    sse([chunk({ content: "ok" }, "stop"), "[DONE]"]),
  );
  const out = await collect(p.stream(request([user("q")]), new AbortController().signal));
  expect(out.at(-1)).toEqual({ type: "finish", reason: "stop" });
});

test("mid-stream error object and truncated stream are errors", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url });
  srv.reply(sse([chunk({ content: "a" }), { error: { message: "upstream died" } }]));
  expect((await collect(p.stream(request([user("q")]), new AbortController().signal))).at(-1)).toEqual({
    type: "finish",
    reason: "error",
    error: "upstream died",
  });
  srv.reply(sse([chunk({ content: "a" })]));
  expect((await collect(p.stream(request([user("q")]), new AbortController().signal))).at(-1)).toEqual({
    type: "finish",
    reason: "error",
    error: "stream ended early",
  });
});

test("abort mid-stream yields cancelled", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url });
  srv.reply(() => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`));
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  const ac = new AbortController();
  const out = await collect(p.stream(request([user("q")]), ac.signal), (c) => {
    if (c.type === "text-delta") ac.abort();
  });
  expect(out.at(-1)).toEqual({ type: "finish", reason: "cancelled" });
});

test("discovers models from GET /models and runs the utility model", async () => {
  const { p } = provider({ api: "openai", baseUrl: srv.url, utilityModel: "small" });
  const before = srv.requests.length;
  srv.replyModels(json({ data: [{ id: "a", context_length: 64000 }, { id: "b" }] }));
  const models = await p.listModels();
  expect(models.map((m) => [m.id, m.contextWindow])).toEqual([
    ["a", 64000],
    ["b", 128000],
  ]);
  await p.listModels();
  expect(srv.requests.slice(before).filter((r) => r.path === "/v1/models")).toHaveLength(1);
  srv.reply(sse([chunk({ content: " A title " }, "stop"), "[DONE]"]));
  expect(p.utility?.model()).toBe("small");
  expect(await p.utility?.complete({ system: "name it", prompt: "chat" }, new AbortController().signal)).toBe(
    "A title",
  );
  expect(srv.requests.at(-1)?.body).toMatchObject({ model: "small" });
  expect(srv.requests.at(-1)?.body.tools).toBeUndefined();
});
