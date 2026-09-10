/**
 * Wire-level tests for the provider layer.
 *
 * No account here has keys for all four vendors, so the only honest way to
 * check "does the request we build get understood, and do we read the reply
 * correctly" is to stand up a stub upstream and point every provider's base URL
 * at it. This catches the things unit tests on the body builders cannot: auth
 * headers, URL shapes, status mapping, and the response readers.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callVisionModel, type Provider, type VisionRequest } from "../providers";
import { ExtractionError } from "../errors";
import { EXTRACTION_JSON_SCHEMA } from "../schema";

const EXTRACTION = {
  courses: [
    {
      name: "CS 2150 Lecture",
      section: "001",
      days: ["MO", "WE", "FR"],
      startTime: "09:30",
      endTime: "10:45",
      location: "Olsson 120",
      instructor: "Dr. Ahmed",
      async: false,
    },
  ],
  warnings: [],
};

/** What the stub does next; each test sets this. */
let handler: (url: string, body: string) => { status: number; json: unknown };

/** The last request the stub received, for asserting on headers and paths. */
let seen: { url: string; headers: Record<string, string | undefined>; body: unknown };

let server: Server;
let origin: string;

function okBody(provider: Provider, text: string): unknown {
  if (provider === "anthropic") {
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
  }
  if (provider === "gemini") {
    return { candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] };
  }
  return { choices: [{ finish_reason: "stop", message: { content: text } }] };
}

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "EXTRACTION_MODEL",
  "EXTRACTION_EFFORT",
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen = { url: req.url ?? "", headers: req.headers as Record<string, string>, body: JSON.parse(body) };
      const { status, json } = handler(req.url ?? "", body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.ANTHROPIC_API_KEY = "test-anthropic";
  process.env.ANTHROPIC_BASE_URL = origin;
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.OPENAI_BASE_URL = `${origin}/v1`;
  process.env.GEMINI_API_KEY = "test-gemini";
  process.env.GEMINI_BASE_URL = `${origin}/v1beta`;
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  process.env.OPENROUTER_BASE_URL = `${origin}/api/v1`;
  delete process.env.EXTRACTION_MODEL;
  delete process.env.EXTRACTION_EFFORT;
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  handler = () => ({ status: 500, json: {} });
});

function request(provider: Provider): VisionRequest {
  return {
    provider,
    imageBase64: "ZmFrZXBuZw==",
    mediaType: "image/png",
    system: "system prompt",
    user: "user prompt",
    schema: EXTRACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
  };
}

const ALL: Provider[] = ["anthropic", "openai", "gemini", "openrouter"];

describe.each(ALL)("%s", (provider) => {
  it("sends the key and reads the extraction back", async () => {
    handler = () => ({ status: 200, json: okBody(provider, JSON.stringify(EXTRACTION)) });

    const result = await callVisionModel(request(provider));
    expect(JSON.parse(result.text)).toEqual(EXTRACTION);
    expect(result.provider).toBe(provider);

    const auth =
      provider === "anthropic"
        ? seen.headers["x-api-key"]
        : provider === "gemini"
          ? seen.headers["x-goog-api-key"]
          : seen.headers.authorization;
    expect(auth).toContain(`test-${provider}`);
    // Every provider must have received the image, whatever it calls the field.
    expect(JSON.stringify(seen.body)).toContain("ZmFrZXBuZw==");
  });

  it("maps a 429 onto our own 429", async () => {
    handler = () => ({ status: 429, json: { error: "slow down" } });
    await expect(callVisionModel(request(provider))).rejects.toMatchObject({ status: 429 });
  });

  it("treats rejected credentials as a server-side 503", async () => {
    handler = () => ({ status: 401, json: { error: "bad key" } });
    await expect(callVisionModel(request(provider))).rejects.toMatchObject({ status: 503 });
  });
});

describe("response readers", () => {
  it("hits the documented URL for each provider", async () => {
    for (const provider of ALL) {
      handler = () => ({ status: 200, json: okBody(provider, JSON.stringify(EXTRACTION)) });
      await callVisionModel(request(provider));
      const expected: Record<Provider, string> = {
        anthropic: "/v1/messages",
        openai: "/v1/chat/completions",
        gemini: "/v1beta/models/gemini-2.5-pro:generateContent",
        openrouter: "/api/v1/chat/completions",
      };
      // The SDK's beta client appends `?beta=true`; the path is what matters.
      expect(seen.url.split("?")[0]).toBe(expected[provider]);
    }
  });

  it("reports a truncated response as a 422 rather than bad JSON", async () => {
    handler = () => ({
      status: 200,
      json: { choices: [{ finish_reason: "length", message: { content: '{"courses":' } }] },
    });
    await expect(callVisionModel(request("openai"))).rejects.toMatchObject({ status: 422 });

    handler = () => ({ status: 200, json: { candidates: [{ finishReason: "MAX_TOKENS" }] } });
    await expect(callVisionModel(request("gemini"))).rejects.toMatchObject({ status: 422 });
  });

  it("reports a refusal as a 422", async () => {
    handler = () => ({
      status: 200,
      json: { choices: [{ finish_reason: "stop", message: { refusal: "no" } }] },
    });
    await expect(callVisionModel(request("openai"))).rejects.toMatchObject({ status: 422 });

    // Gemini blocks the prompt outright: 200, no candidates at all.
    handler = () => ({ status: 200, json: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(callVisionModel(request("gemini"))).rejects.toMatchObject({ status: 422 });

    handler = () => ({
      status: 200,
      json: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] },
    });
    await expect(callVisionModel(request("gemini"))).rejects.toMatchObject({ status: 422 });
  });

  it("rejects an empty candidate list instead of returning empty courses", async () => {
    handler = () => ({ status: 200, json: { choices: [] } });
    await expect(callVisionModel(request("openai"))).rejects.toBeInstanceOf(ExtractionError);
  });

  it("sends OpenRouter its attribution header", async () => {
    handler = () => ({ status: 200, json: okBody("openrouter", JSON.stringify(EXTRACTION)) });
    await callVisionModel(request("openrouter"));
    expect(seen.headers["x-title"]).toBe("schedule-to-calendar");
  });
});
