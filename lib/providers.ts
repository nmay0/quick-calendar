/**
 * Vision providers.
 *
 * Extraction is one call — image + system prompt + JSON schema in, JSON text
 * out — so every provider implements exactly that. `lib/extract.ts` owns the
 * prompt and the normalization; this file owns "how do I ask <vendor> for it".
 *
 * Anthropic goes through the official SDK (it is the only one whose extras —
 * server-side refusal fallbacks, `output_config.effort` — we use). The other
 * three are plain `fetch` against documented REST shapes: adding three SDKs to
 * send three JSON bodies is not worth the dependency surface, and OpenAI and
 * OpenRouter share one implementation because OpenRouter is OpenAI-compatible.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ExtractionError } from "./errors";

export const PROVIDERS = ["anthropic", "openai", "gemini", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * The intersection of what the four providers accept as inline image data.
 * These live here rather than in `lib/extract.ts` because they are facts about
 * the vendor APIs, not about schedules.
 */
export const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Anthropic's per-image ceiling is 5MB base64-encoded and it is the tightest of
 * the four; leave room for the JSON overhead around it.
 */
export const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

interface ProviderSpec {
  label: string;
  /** Key env vars, first non-empty wins. */
  keyEnv: readonly string[];
  /** Model env vars, first non-empty wins. `EXTRACTION_MODEL` is the legacy global. */
  modelEnv: readonly string[];
  /**
   * Starting points, not guarantees — every account has a different model list.
   * Override with the provider's own env var.
   */
  defaultModel: string;
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  /**
   * Reasoning models bill thinking against the same ceiling as the answer, so
   * the providers whose defaults reason get more room than Claude needs.
   */
  maxOutputTokens: number;
}

export const PROVIDER_SPECS: Record<Provider, ProviderSpec> = {
  anthropic: {
    label: "Anthropic",
    keyEnv: ["ANTHROPIC_API_KEY"],
    modelEnv: ["ANTHROPIC_MODEL", "EXTRACTION_MODEL"],
    defaultModel: "claude-opus-5",
    maxOutputTokens: 8000,
  },
  openai: {
    label: "OpenAI",
    keyEnv: ["OPENAI_API_KEY"],
    modelEnv: ["OPENAI_MODEL", "EXTRACTION_MODEL"],
    defaultModel: "gpt-5",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    maxOutputTokens: 16000,
  },
  gemini: {
    label: "Google Gemini",
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    modelEnv: ["GEMINI_MODEL", "EXTRACTION_MODEL"],
    defaultModel: "gemini-2.5-pro",
    baseUrlEnv: "GEMINI_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    maxOutputTokens: 16000,
  },
  openrouter: {
    label: "OpenRouter",
    keyEnv: ["OPENROUTER_API_KEY"],
    modelEnv: ["OPENROUTER_MODEL", "EXTRACTION_MODEL"],
    // OpenRouter model ids are always `vendor/model`; a bare id is a 400.
    defaultModel: "google/gemini-2.5-pro",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    maxOutputTokens: 16000,
  },
};

/** Preference order when nothing is pinned: whichever key is present, in this order. */
const PREFERENCE: readonly Provider[] = PROVIDERS;

function env(name: string): string | null {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function firstEnv(names: readonly string[]): string | null {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return null;
}

export function apiKeyFor(provider: Provider): string | null {
  return firstEnv(PROVIDER_SPECS[provider].keyEnv);
}

export function modelFor(provider: Provider): string {
  const spec = PROVIDER_SPECS[provider];
  return firstEnv(spec.modelEnv) ?? spec.defaultModel;
}

function baseUrlFor(provider: Provider): string {
  const spec = PROVIDER_SPECS[provider];
  const configured = spec.baseUrlEnv ? env(spec.baseUrlEnv) : null;
  return (configured ?? spec.defaultBaseUrl ?? "").replace(/\/+$/, "");
}

/** Providers this deployment actually has credentials for. */
export function configuredProviders(): Provider[] {
  return PREFERENCE.filter((p) => apiKeyFor(p) !== null);
}

function missingKeyMessage(provider: Provider): string {
  const spec = PROVIDER_SPECS[provider];
  return `The server has no ${spec.keyEnv[0]}, so ${spec.label} extraction is unavailable.`;
}

/**
 * Decide which provider handles this request.
 *
 * Per-request `requested` wins (an integrator may want a specific vendor), then
 * `EXTRACTION_PROVIDER`, then whichever key happens to be configured. Asking
 * for a provider with no key is a 503, never a silent switch to another vendor:
 * a caller who pinned one has a reason.
 */
export function resolveProvider(requested?: string | null): Provider {
  if (requested) {
    if (!isProvider(requested)) {
      throw new ExtractionError(
        `Unknown provider "${requested}". Use one of: ${PROVIDERS.join(", ")}.`,
        400,
      );
    }
    if (!apiKeyFor(requested)) throw new ExtractionError(missingKeyMessage(requested), 503);
    return requested;
  }

  const pinned = env("EXTRACTION_PROVIDER")?.toLowerCase();
  if (pinned) {
    if (!isProvider(pinned)) {
      throw new ExtractionError(
        `EXTRACTION_PROVIDER is set to "${pinned}", which is not one of: ${PROVIDERS.join(", ")}.`,
        503,
      );
    }
    if (!apiKeyFor(pinned)) throw new ExtractionError(missingKeyMessage(pinned), 503);
    return pinned;
  }

  const available = configuredProviders();
  if (available.length === 0) {
    const names = PROVIDERS.map((p) => PROVIDER_SPECS[p].keyEnv[0]).join(", ");
    throw new ExtractionError(
      `The server has no extraction API key, so extraction is unavailable. Set one of: ${names}.`,
      503,
    );
  }
  return available[0];
}

/**
 * `null` means "the operator did not ask for a specific effort". Anthropic always
 * gets a value (the SDK field is ours to set and `medium` is a deliberate
 * default); the OpenAI-compatible providers get nothing, because sending
 * `reasoning_effort` to a model that has no reasoning mode is a 400 and the
 * vendor default already matches what we would have asked for.
 */
export function effortSetting(): Effort | null {
  const raw = env("EXTRACTION_EFFORT");
  return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as Effort) : null;
}

/**
 * OpenAI-style `reasoning_effort` only knows low/medium/high, so the two levels
 * above `high` collapse onto it rather than being dropped.
 */
export function openAiReasoningEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" ? "low" : effort === "medium" ? "medium" : "high";
}

export interface VisionRequest {
  provider: Provider;
  imageBase64: string;
  mediaType: SupportedImageType;
  system: string;
  user: string;
  /** JSON Schema the response must conform to. */
  schema: Record<string, unknown>;
}

export interface VisionResponse {
  /** Raw JSON text from the model. */
  text: string;
  provider: Provider;
  model: string;
}

/** Leaves headroom under the route's 60s `maxDuration` for our own error handling. */
const REQUEST_TIMEOUT_MS = 55_000;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * Server-side refusal fallbacks are opt-in. They cost nothing when unused and
 * turn a hard failure into a served response, so they're on unless disabled.
 */
const FALLBACKS_ENABLED = process.env.DISABLE_REFUSAL_FALLBACKS !== "1";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** True when a request failed specifically because of the beta fallback opt-in. */
function isFallbackOptInRejection(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  return /fallback/i.test(error.message);
}

async function callAnthropic(req: VisionRequest): Promise<VisionResponse> {
  const client = new Anthropic({ apiKey: apiKeyFor("anthropic")! });
  const model = modelFor("anthropic");

  const request = {
    model,
    max_tokens: PROVIDER_SPECS.anthropic.maxOutputTokens,
    system: req.system,
    output_config: {
      effort: effortSetting() ?? "medium",
      format: { type: "json_schema" as const, schema: req.schema },
    },
    messages: [
      {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: req.mediaType,
              data: req.imageBase64,
            },
          },
          { type: "text" as const, text: req.user },
        ],
      },
    ],
  };

  /**
   * The beta and non-beta message types differ only in ways we don't touch, so
   * both branches are read through this minimal shape.
   */
  interface ModelResponse {
    stop_reason: string | null;
    content: Array<{ type: string; text?: string }>;
  }

  let response: ModelResponse;
  try {
    response = FALLBACKS_ENABLED
      ? ((await client.beta.messages.create({
          ...request,
          betas: [FALLBACK_BETA],
          fallbacks: "default",
          // `fallbacks` is a beta parameter the SDK types don't carry yet.
        } as Parameters<typeof client.beta.messages.create>[0])) as ModelResponse)
      : ((await client.messages.create(request)) as ModelResponse);
  } catch (error) {
    // The fallback opt-in is a beta surface; if this deployment's account or
    // API version rejects it, fall through to a plain request rather than
    // failing the upload.
    if (FALLBACKS_ENABLED && isFallbackOptInRejection(error)) {
      response = (await client.messages.create(request)) as ModelResponse;
    } else if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      // A bad key is a server misconfiguration, not something the user did.
      console.error("Anthropic rejected our credentials", error.status);
      throw new ExtractionError("The server's extraction credentials were rejected.", 503);
    } else if (error instanceof Anthropic.RateLimitError) {
      throw new ExtractionError(
        "The extraction service is busy right now. Try again in a moment.",
        429,
      );
    } else if (error instanceof Anthropic.APIError) {
      throw new ExtractionError("The extraction service rejected the request.", 502);
    } else {
      throw new ExtractionError("Could not reach the extraction service.", 502);
    }
  }

  // Check the stop reason before touching content: a refusal returns HTTP 200
  // with an empty or partial content array.
  if (response.stop_reason === "refusal") throw refusalError();
  if (response.stop_reason === "max_tokens") throw truncatedError();

  const text = response.content.find((block) => block.type === "text")?.text;
  if (!text) throw new ExtractionError("The model returned an empty response.");
  return { text, provider: "anthropic", model };
}

// ---------------------------------------------------------------------------
// Shared errors for the non-SDK providers
// ---------------------------------------------------------------------------

function refusalError(): ExtractionError {
  return new ExtractionError(
    "The model declined to read this image. Try a screenshot that shows only your class schedule.",
    422,
  );
}

function truncatedError(): ExtractionError {
  return new ExtractionError(
    "That schedule was too long to read in one pass. Try uploading it in sections.",
    422,
  );
}

/** Map an HTTP failure onto the status we hand the browser. */
function httpError(provider: Provider, status: number, body: string): ExtractionError {
  const label = PROVIDER_SPECS[provider].label;
  if (status === 429) {
    return new ExtractionError(
      "The extraction service is busy right now. Try again in a moment.",
      429,
    );
  }
  if (status === 401 || status === 403) {
    // A bad key is a server misconfiguration, not something the user did.
    console.error(`${label} rejected our credentials (${status}): ${body.slice(0, 500)}`);
    return new ExtractionError(
      "The server's extraction credentials were rejected.",
      503,
    );
  }
  console.error(`${label} request failed (${status}): ${body.slice(0, 500)}`);
  return new ExtractionError("The extraction service rejected the request.", 502);
}

async function postJson(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ExtractionError("Could not reach the extraction service.", 502);
  }

  if (!response.ok) {
    throw httpError(provider, response.status, await response.text().catch(() => ""));
  }

  try {
    return await response.json();
  } catch {
    throw new ExtractionError("The extraction service returned an unreadable response.");
  }
}

// ---------------------------------------------------------------------------
// OpenAI + OpenRouter (chat completions)
// ---------------------------------------------------------------------------

/**
 * Both speak `/chat/completions`. Kept as one builder so the two can't drift;
 * the differences are the base URL, the auth headers, and the token field name
 * (OpenAI's reasoning models require `max_completion_tokens`).
 */
export function buildChatCompletionsBody(
  provider: Provider,
  req: VisionRequest,
  model: string,
  effort: Effort | null,
): Record<string, unknown> {
  const tokenField = provider === "openai" ? "max_completion_tokens" : "max_tokens";
  // OpenRouter documents `reasoning: {effort}` and ignores it on models without
  // a reasoning mode; OpenAI wants the flat field. Both are omitted entirely
  // unless EXTRACTION_EFFORT was set.
  const reasoning = !effort
    ? {}
    : provider === "openrouter"
      ? { reasoning: { effort: openAiReasoningEffort(effort) } }
      : { reasoning_effort: openAiReasoningEffort(effort) };
  return {
    model,
    [tokenField]: PROVIDER_SPECS[provider].maxOutputTokens,
    ...reasoning,
    messages: [
      { role: "system", content: req.system },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${req.mediaType};base64,${req.imageBase64}` },
          },
          { type: "text", text: req.user },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "schedule_extraction", strict: true, schema: req.schema },
    },
  };
}

interface ChatCompletionsResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

async function callChatCompletions(req: VisionRequest): Promise<VisionResponse> {
  const provider = req.provider;
  const model = modelFor(provider);
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKeyFor(provider)!}`,
  };
  if (provider === "openrouter") {
    // OpenRouter attributes traffic with these; both are optional but it asks
    // for them and they show up in the account's dashboard.
    const referer = env("OPENROUTER_SITE_URL");
    const title = env("OPENROUTER_SITE_NAME") ?? "schedule-to-calendar";
    if (referer) headers["HTTP-Referer"] = referer;
    headers["X-Title"] = title;
  }

  const json = (await postJson(
    provider,
    `${baseUrlFor(provider)}/chat/completions`,
    headers,
    buildChatCompletionsBody(provider, req, model, effortSetting()),
  )) as ChatCompletionsResponse;

  const choice = json.choices?.[0];
  if (!choice) throw new ExtractionError("The model returned an empty response.");
  if (choice.message?.refusal) throw refusalError();
  if (choice.finish_reason === "length") throw truncatedError();
  if (choice.finish_reason === "content_filter") throw refusalError();

  const text = choice.message?.content;
  if (!text) throw new ExtractionError("The model returned an empty response.");
  return { text, provider, model };
}

// ---------------------------------------------------------------------------
// Gemini (generateContent)
// ---------------------------------------------------------------------------

/**
 * Gemini's `responseSchema` is an OpenAPI 3.0 subset, not JSON Schema: it has
 * no `additionalProperties`, and nullability is a `nullable` flag rather than
 * an `anyOf` with a null branch. Translating here keeps `EXTRACTION_JSON_SCHEMA`
 * as the single source of truth instead of maintaining a second copy.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (typeof schema !== "object" || schema === null) return schema;

  const input = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "additionalProperties" || key === "anyOf") continue;
    if (key === "items") {
      output[key] = toGeminiSchema(value);
    } else if (key === "properties" && value !== null && typeof value === "object") {
      output[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else {
      output[key] = value;
    }
  }

  if (Array.isArray(input.anyOf)) {
    const branches = input.anyOf;
    const nonNull = branches.filter((branch) => !isNullBranch(branch));
    if (nonNull.length === 1 && nonNull.length < branches.length) {
      // The shared schema's "optional scalar" idiom. Keep the wrapper's own
      // keys (description, ...) and take `type` from the surviving branch.
      return { ...(toGeminiSchema(nonNull[0]) as object), ...output, nullable: true };
    }
    output.anyOf = branches.map(toGeminiSchema);
  }

  return output;
}

function isNullBranch(branch: unknown): boolean {
  return (
    typeof branch === "object" &&
    branch !== null &&
    (branch as Record<string, unknown>).type === "null"
  );
}

export function buildGeminiBody(
  req: VisionRequest,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [
      {
        role: "user",
        parts: [
          { inline_data: { mime_type: req.mediaType, data: req.imageBase64 } },
          { text: req.user },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: toGeminiSchema(req.schema),
      maxOutputTokens,
    },
  };
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function callGemini(req: VisionRequest): Promise<VisionResponse> {
  const model = modelFor("gemini");
  const json = (await postJson(
    "gemini",
    `${baseUrlFor("gemini")}/models/${encodeURIComponent(model)}:generateContent`,
    { "x-goog-api-key": apiKeyFor("gemini")! },
    buildGeminiBody(req, PROVIDER_SPECS.gemini.maxOutputTokens),
  )) as GeminiResponse;

  // A blocked prompt comes back 200 with no candidates at all.
  if (json.promptFeedback?.blockReason) throw refusalError();

  const candidate = json.candidates?.[0];
  if (!candidate) throw new ExtractionError("The model returned an empty response.");
  if (candidate.finishReason === "MAX_TOKENS") throw truncatedError();
  if (candidate.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
    // SAFETY, RECITATION, PROHIBITED_CONTENT, BLOCKLIST — all "won't answer".
    throw refusalError();
  }

  const text = (candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new ExtractionError("The model returned an empty response.");
  return { text, provider: "gemini", model };
}

// ---------------------------------------------------------------------------

export function callVisionModel(req: VisionRequest): Promise<VisionResponse> {
  switch (req.provider) {
    case "anthropic":
      return callAnthropic(req);
    case "gemini":
      return callGemini(req);
    case "openai":
    case "openrouter":
      return callChatCompletions(req);
  }
}
