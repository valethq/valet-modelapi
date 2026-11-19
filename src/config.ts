export type ApiKind = "openai" | "anthropic";

export interface ModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  /** Effort levels the model takes; listed once on ModelInfo, chosen via InferenceRequest.effort. */
  efforts?: string[];
  /** Effort used when the request omits one. */
  defaultEffort?: string;
  /** The model has a fast mode (OpenAI service_tier / Anthropic speed). */
  fast?: boolean;
  /** Fast mode is on unless the request turns it off. */
  fastByDefault?: boolean;
  /** Deep-merged into every request body for this model, after the endpoint's `body`. */
  body?: Record<string, unknown>;
}

/** A model the user adds by hand; `id` is sent to the endpoint unchanged, `name` is the picker label. */
export interface CustomModel {
  id: string;
  name?: string;
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
  /** Extra picker entries added to the model list. */
  customModels?: CustomModel[];
}

export interface ModelApiConfig {
  endpoints?: EndpointConfig[];
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT = 32_000;
export const ANTHROPIC_VERSION = "2023-06-01";
