import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeServer, type Json, sse } from "./fake-server";

// Boots the real kernel with valet-agent and valet-contextmanager; this plugin points at a fake API.
const CORE = process.env.VALET_CORE_DIR ?? join(import.meta.dir, "..", "..", "valet-core");
const CLI = join(CORE, "packages/core/src/cli.ts");
const VALET = join(import.meta.dir, "..", "..");
const ROOT = join(import.meta.dir, "..");
const AUTH = { authorization: "Bearer tok", "content-type": "application/json" };

const srv = fakeServer();
let home: string;
let base: string;
let proc: Bun.Subprocess;

function shim(id: string, dir: string): void {
  const out = join(home, "plugins", id);
  mkdirSync(out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ ...manifest, main: "./index.ts" }));
  const main = join(dir, manifest.main);
  writeFileSync(join(out, "index.ts"), `export { default } from ${JSON.stringify(main)};\n`);
}

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Json> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: AUTH,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return res.json();
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "valet-modelapi-"));
  shim("valet-modelapi", ROOT);
  shim("valet-agent", join(VALET, "valet-agent"));
  shim("valet-contextmanager", join(VALET, "valet-contextmanager"));
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  await probe.stop(true);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { port },
      pluginPaths: [join(import.meta.dir, "fixtures", "plugins"), join(home, "plugins")],
      plugins: {
        "valet-fixture-auth": { config: { token: "tok" } },
        "valet-modelapi": {
          config: {
            endpoints: [{ id: "fake-openai", api: "openai", baseUrl: srv.url, models: [{ id: "m1" }] }],
          },
        },
      },
    }),
  );
  proc = Bun.spawn(["bun", CLI, "start", "--home", home], {
    stdout: Bun.file(join(home, "out.log")),
    stderr: Bun.file(join(home, "err.log")),
  });
  base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/`)).status === 200, 15_000);
}, 20_000);

afterAll(async () => {
  proc?.kill("SIGTERM");
  await proc?.exited;
  srv.stop();
});

const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
});

test("lists the endpoint's models and runs a tool loop through valet-agent", async () => {
  const plugins: Json = await api("/api/core/plugins");
  const states = Object.fromEntries(
    (Array.isArray(plugins) ? plugins : plugins.plugins).map((p: Json) => [p.id, p.state]),
  );
  expect(states["valet-modelapi"]).toBe("active");

  const models: Json = await api("/plugins/valet-agent/models");
  expect(models.providers).toContainEqual(
    expect.objectContaining({
      provider: "fake-openai",
      kind: "model",
      models: [expect.objectContaining({ id: "m1" })],
    }),
  );

  srv.reply(
    sse([
      chunk({ tool_calls: [{ index: 0, id: "t1", function: { name: "echo", arguments: '{"a":1}' } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ]),
    sse([chunk({ content: "all done" }, "stop"), "[DONE]"]),
  );
  const project = await api("/api/core/projects", {
    method: "POST",
    body: { name: "p", workspaceDir: mkdtempSync(join(tmpdir(), "valet-modelapi-ws-")) },
  });
  const session = await api("/api/core/sessions", {
    method: "POST",
    body: { projectId: project.id, settings: { model: { provider: "fake-openai", model: "m1" } } },
  });
  await api(`/api/core/sessions/${session.id}/messages`, {
    method: "POST",
    body: { role: "user", parts: [{ type: "text", text: "use the tool" }] },
  });
  const reply = await waitFor(async () => {
    const list: Json[] = await api(`/api/core/sessions/${session.id}/messages`);
    const a = list.find((m) => m.message.role === "assistant");
    return a && a.message.status !== "streaming" && a;
  });
  expect(reply.message.status).toBe("complete");
  expect(reply.parts.map((p: Json) => p.type)).toEqual(["tool-call", "text"]);
  expect(reply.parts[0].data).toMatchObject({
    callId: "t1",
    name: "echo",
    status: "done",
    output: 'echo:{"a":1}',
  });
  expect(reply.parts[1].data.text).toBe("all done");

  const second = srv.requests.filter((r) => r.path === "/v1/chat/completions").at(-1)?.body;
  expect(second.messages.slice(-2)).toEqual([
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "echo", arguments: '{"a":1}' } }],
    },
    { role: "tool", tool_call_id: "t1", content: 'echo:{"a":1}' },
  ]);
}, 20_000);
