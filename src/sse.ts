export interface SseEvent {
  event: string;
  data: string;
}

/** Server-sent events from a fetch body. Comments and ids are ignored. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    const out = data.length ? { event: event || "message", data: data.join("\n") } : undefined;
    event = "";
    data = [];
    return out;
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        const ev = flush();
        if (ev) yield ev;
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
    }
  }
  if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
  const last = flush();
  if (last) yield last;
}
