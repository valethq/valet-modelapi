export type ApiKind = "openai" | "anthropic";

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  /** Effort levels offered as picker entries "<id>-<effort>"; sent as reasoning_effort / output_config.effort. */
  efforts?: string[];
  /** Deep-merged into every request body for this model, after the endpoint's `body`. */
  body?: Record<string, unknown>;
}

export interface EndpointConfig {
  /** Provider key, e.g. "cliproxy". Sessions pick models as { provider: id, model }. */
  id: string;
  label?: string;
  api: ApiKind;
  /** Includes the version path: "https://api.openai.com/v1", "https://api.anthropic.com/v1". */
  baseUrl: string;
  /** Secret name resolved through ctx.secrets (~/.valet/secrets/<name>, then env <NAME>). */
  apiKeySecret?: string;
  /** How the key is sent. Default: bearer for openai, x-api-key for anthropic. */
  auth?: "bearer" | "x-api-key";
  headers?: Record<string, string>;
  /** Deep-merged into every request body, e.g. { "thinking": { "type": "adaptive" } }. */
  body?: Record<string, unknown>;
  /** Anthropic only: cache_control breakpoints on the system prompt and the last message. Default true. */
  promptCache?: boolean;
  /** Model for small side jobs such as session naming. Unset or empty = none. */
  utilityModel?: string;
  /** Retries on 408/409/429/5xx and connection errors before any output. Default 2. */
  retries?: number;
  /** Unset = discovered from GET <baseUrl>/models. */
  models?: ModelConfig[];
}

export interface ModelApiConfig {
  endpoints?: EndpointConfig[];
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 32_000;
export const ANTHROPIC_VERSION = "2023-06-01";
