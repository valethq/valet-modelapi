// biome-ignore lint/suspicious/noExplicitAny: untyped JSON bodies in tests
export type Json = any;

export interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Json;
}

export type Reply = Response | (() => Response);

/**
 * A scripted HTTP server. Generation requests take the next `reply`; GET /models takes the next
 * `replyModels`, or an empty listing.
 */
export function fakeServer() {
  const requests: Recorded[] = [];
  const queue: Reply[] = [];
  const models: Reply[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers),
        body: text ? JSON.parse(text) : undefined,
      });
      const next = url.pathname.endsWith("/models") ? (models.shift() ?? json({ data: [] })) : queue.shift();
      if (!next) return new Response("no reply queued", { status: 500 });
      return typeof next === "function" ? next() : next;
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    reply: (...r: Reply[]) => void queue.push(...r),
    replyModels: (...r: Reply[]) => void models.push(...r),
    stop: () => server.stop(true),
  };
}

export function sse(events: (Json | string)[], opts: { named?: boolean } = {}): () => Response {
  return () =>
    new Response(
      events
        .map((e) => {
          const data = typeof e === "string" ? e : JSON.stringify(e);
          const name = opts.named && typeof e === "object" ? `event: ${e.type}\n` : "";
          return `${name}data: ${data}\n\n`;
        })
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
}

export const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
