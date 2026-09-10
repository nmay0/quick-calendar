import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROVIDER_SPECS,
  buildChatCompletionsBody,
  buildGeminiBody,
  configuredProviders,
  modelFor,
  resolveProvider,
  toGeminiSchema,
  type VisionRequest,
} from "../providers";
import { ExtractionError } from "../errors";
import { EXTRACTION_JSON_SCHEMA } from "../schema";
import { parseModelOutput } from "../extract";

/** Every env var the provider layer reads, so each test starts from nothing. */
const MANAGED = [
  "EXTRACTION_PROVIDER",
  "EXTRACTION_MODEL",
  "EXTRACTION_EFFORT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_MODEL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of MANAGED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of MANAGED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ExtractionError) return error.status;
    throw error;
  }
  throw new Error("expected an ExtractionError");
}

describe("provider resolution", () => {
  it("reports no provider when no key is configured", () => {
    expect(configuredProviders()).toEqual([]);
    expect(statusOf(() => resolveProvider())).toBe(503);
  });

  it("uses whichever single key is present", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(resolveProvider()).toBe("openai");
    expect(configuredProviders()).toEqual(["openai"]);
  });

  it("accepts GOOGLE_API_KEY as an alias for GEMINI_API_KEY", () => {
    process.env.GOOGLE_API_KEY = "goog-test";
    expect(resolveProvider()).toBe("gemini");
  });

  it("prefers Anthropic when several keys are present", () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GEMINI_API_KEY = "goog-test";
    expect(resolveProvider()).toBe("anthropic");
    expect(configuredProviders()).toEqual(["anthropic", "gemini", "openrouter"]);
  });

  it("honours EXTRACTION_PROVIDER over the preference order", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.EXTRACTION_PROVIDER = "openrouter";
    expect(resolveProvider()).toBe("openrouter");
  });

  it("lets a caller pin a provider per request", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GEMINI_API_KEY = "goog-test";
    expect(resolveProvider("gemini")).toBe("gemini");
  });

  it("never silently falls back to a different vendor", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    // Asking for OpenAI with no OpenAI key is an error, not a switch to Claude.
    expect(statusOf(() => resolveProvider("openai"))).toBe(503);
    process.env.EXTRACTION_PROVIDER = "gemini";
    expect(statusOf(() => resolveProvider())).toBe(503);
  });

  it("rejects an unknown provider name as a client error", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(statusOf(() => resolveProvider("llama"))).toBe(400);
  });
});

describe("model selection", () => {
  it("falls back to the per-provider default", () => {
    expect(modelFor("openai")).toBe(PROVIDER_SPECS.openai.defaultModel);
  });

  it("prefers the provider's own env var over the global one", () => {
    process.env.EXTRACTION_MODEL = "global-model";
    expect(modelFor("gemini")).toBe("global-model");
    process.env.GEMINI_MODEL = "gemini-specific";
    expect(modelFor("gemini")).toBe("gemini-specific");
    // The global still applies to a provider with no specific override.
    expect(modelFor("openai")).toBe("global-model");
  });
});

const REQUEST: VisionRequest = {
  provider: "openai",
  imageBase64: "AAAA",
  mediaType: "image/png",
  system: "system prompt",
  user: "user prompt",
  schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
};

describe("chat-completions body", () => {
  it("sends the image as a data URI and asks for a strict schema", () => {
    const body = buildChatCompletionsBody("openai", REQUEST, "gpt-test", "medium");
    const content = (body.messages as Array<{ role: string; content: unknown }>)[1]
      .content as Array<Record<string, { url?: string }>>;
    expect(content[0].image_url.url).toBe("data:image/png;base64,AAAA");
    const format = body.response_format as { json_schema: { strict: boolean } };
    expect(format.json_schema.strict).toBe(true);
  });

  it("uses max_completion_tokens for OpenAI and max_tokens for OpenRouter", () => {
    const openai = buildChatCompletionsBody("openai", REQUEST, "gpt-test", "high");
    expect(openai.max_completion_tokens).toBe(PROVIDER_SPECS.openai.maxOutputTokens);
    expect(openai.max_tokens).toBeUndefined();

    const openrouter = buildChatCompletionsBody(
      "openrouter",
      { ...REQUEST, provider: "openrouter" },
      "vendor/model",
      "high",
    );
    expect(openrouter.max_tokens).toBe(PROVIDER_SPECS.openrouter.maxOutputTokens);
    expect(openrouter.max_completion_tokens).toBeUndefined();
  });

  it("only sends a reasoning setting when one was configured", () => {
    // Unset is the common case: a non-reasoning model 400s on the field.
    expect(buildChatCompletionsBody("openai", REQUEST, "gpt-test", null).reasoning_effort)
      .toBeUndefined();
    // Effort levels above `high` collapse onto it — OpenAI knows only three.
    expect(buildChatCompletionsBody("openai", REQUEST, "gpt-test", "max").reasoning_effort)
      .toBe("high");
    // OpenRouter spells the same setting differently.
    const or = buildChatCompletionsBody(
      "openrouter",
      { ...REQUEST, provider: "openrouter" },
      "vendor/model",
      "low",
    );
    expect(or.reasoning).toEqual({ effort: "low" });
    expect(or.reasoning_effort).toBeUndefined();
  });
});

describe("gemini schema conversion", () => {
  const converted = toGeminiSchema(EXTRACTION_JSON_SCHEMA) as Record<string, never>;
  const json = JSON.stringify(converted);

  it("drops additionalProperties everywhere", () => {
    expect(json).not.toContain("additionalProperties");
  });

  it("rewrites nullable anyOf branches as nullable: true", () => {
    expect(json).not.toContain("anyOf");
    const course = (converted as unknown as {
      properties: { courses: { items: { properties: Record<string, Record<string, unknown>> } } };
    }).properties.courses.items.properties;
    expect(course.section).toMatchObject({ type: "string", nullable: true });
    // Non-nullable fields are left alone.
    expect(course.async).toMatchObject({ type: "boolean" });
    expect(course.async.nullable).toBeUndefined();
  });

  it("keeps descriptions, required lists, and enums intact", () => {
    const courses = (converted as unknown as {
      properties: {
        courses: {
          items: {
            required: string[];
            properties: { days: { items: { enum: string[] } }; name: { description: string } };
          };
        };
      };
    }).properties.courses;
    expect(courses.items.required).toContain("instructor");
    expect(courses.items.properties.days.items.enum).toContain("MO");
    expect(courses.items.properties.name.description).toMatch(/Course code/);
  });

  it("puts the schema and the image in the request body Gemini expects", () => {
    const body = buildGeminiBody({ ...REQUEST, provider: "gemini" }, 1234);
    const parts = (body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    expect(parts[0]).toEqual({ inline_data: { mime_type: "image/png", data: "AAAA" } });
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.maxOutputTokens).toBe(1234);
    expect(JSON.stringify(config.responseSchema)).not.toContain("additionalProperties");
  });
});

describe("model output parsing", () => {
  const payload = {
    courses: [
      {
        name: "CS 101",
        section: null,
        days: ["MO", "WE"],
        startTime: "9:30",
        endTime: "10:45",
        location: null,
        instructor: null,
        async: false,
      },
    ],
    warnings: [],
  };

  it("reads a plain JSON response", () => {
    const result = parseModelOutput(JSON.stringify(payload));
    expect(result.courses[0].startTime).toBe("09:30");
  });

  it("unwraps a markdown-fenced response", () => {
    const fenced = "```json\n" + JSON.stringify(payload) + "\n```";
    expect(parseModelOutput(fenced).courses).toHaveLength(1);
  });

  it("rejects output that is not JSON at all", () => {
    expect(() => parseModelOutput("I can't read that image.")).toThrow(ExtractionError);
  });
});
