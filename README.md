# valet-modelapi

`inference@1` **model** providers (ARCHITECTURE 6.1, kind `"model"`) for any OpenAI-compatible
Chat Completions API or Anthropic Messages-compatible API. valet-agent runs the tool loop and
valet-contextmanager owns the history; this plugin only translates requests and streams.

Each entry in `endpoints` becomes its own provider, keyed by its `id`, so a session picks
`{ "provider": "<id>", "model": "<model id>" }` and fallbacks can cross endpoints.

No runtime dependencies: both wire protocols are spoken over `fetch` + a small SSE reader, so the
same code works against first-party APIs and the many servers that only imitate them (CLIProxyAPI,
OpenRouter, vLLM, llama.cpp, LiteLLM, DeepSeek, ...).

## Config

```json
{
  "plugins": {
    "valet-modelapi": {
      "config": {
        "endpoints": [
          {
            "id": "local",
            "label": "Local OpenAI-compatible server",
            "api": "openai",
            "baseUrl": "http://127.0.0.1:8000/v1",
            "apiKeySecret": "local_key"
          },
          {
            "id": "anthropic",
            "label": "Anthropic API",
            "api": "anthropic",
            "baseUrl": "https://api.anthropic.com/v1",
            "apiKeySecret": "anthropic_api_key",
            "body": { "thinking": { "type": "adaptive", "display": "summarized" } },
            "utilityModel": "claude-haiku-5-5",
            "models": [
              {
                "id": "claude-opus-5-5",
                "name": "Claude Opus 5.5",
                "contextWindow": 1000000,
                "maxOutputTokens": 64000,
                "input": ["text", "image"],
                "efforts": ["low", "medium", "high", "xhigh", "max"]
              }
            ]
          }
        ]
      }
    }
  }
}
```

| Field              | Meaning                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `id`               | Provider key (required, unique).                                                                |
| `api`              | `"openai"` (POST `/chat/completions`) or `"anthropic"` (POST `/messages`).                      |
| `baseUrl`          | Includes the version path, e.g. `https://api.openai.com/v1`.                                    |
| `apiKeySecret`     | Secret name: `~/.valet/secrets/<name>`, then env `<NAME>`. Omit for keyless local servers.      |
| `auth`             | `"bearer"` or `"x-api-key"`. Default: bearer for openai, x-api-key for anthropic.               |
| `headers`          | Extra headers, e.g. `anthropic-beta`, `HTTP-Referer`.                                           |
| `body`             | Deep-merged into every request (thinking config, `fallbacks`, provider routing, sampling).      |
| `models`           | The picker list. Unset = `GET <baseUrl>/models`, cached 10 min. Unknown ids still pass through. |
| `models[].efforts` | Adds picker entries `<id>-<effort>`; sent as `reasoning_effort` / `output_config.effort`.       |
| `models[].body`    | Per-model request overrides, merged after the endpoint's `body`.                                |
| `promptCache`      | Anthropic: `cache_control` on the system prompt and the last message. Default `true`.           |
| `utilityModel`     | Model for side jobs such as session naming. Unset = none.                                       |
| `retries`          | Retries on 408/409/429/5xx/529 and connection errors before the stream starts. Default 2.       |

## Behaviour notes

- **Usage.** `inputTokens` is uncached input (Anthropic: `input_tokens + cache_creation_input_tokens`;
  OpenAI: `prompt_tokens - cached_tokens`), `cacheReadTokens` the cached part, so valet-agent's
  `contextTokens` is the full prompt.
- **Reasoning replay.** `ModelContent` has no reasoning slot, so the agent hands back tool-call turns
  without it. The provider remembers each streamed turn by tool call id and restores it on the next
  request: the Anthropic turn verbatim (signed `thinking` blocks, text, `tool_use`), and for OpenAI
  servers that stream `reasoning_content`/`reasoning`, that field on the assistant message. The cache
  is in memory (512 calls), so it covers tool loops, not a restart.
- **Errors.** HTTP errors, mid-stream `error` events, refusals (`refused (<category>)`) and truncated
  streams all end with `finish: error`, so valet-agent's fallbacks apply. Abort ends with `cancelled`.
- **Images.** Blobs are inlined as base64. OpenAI tool messages are text-only, so images a tool returns
  follow as a user message.
- **OpenAI token cap.** No `max_tokens`/`max_completion_tokens` is sent by default, since servers
  disagree on which one they accept; set it in `body` if you want one. Anthropic always gets
  `max_tokens` (the model's `maxOutputTokens`, default 32000).
- Anthropic requests send `anthropic-version: 2023-06-01`; override it in `headers`.
