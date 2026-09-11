/**
 * Regression tests for the slow-model timeout path.
 *
 * These vendors send response headers as soon as they accept the request and
 * only then hold the connection open while the model generates. That means a
 * too-slow model aborts *mid-body*, with `response.ok` already true — a
 * different code path from a request that never connects, and one that was
 * previously reported as "unreadable response" / 502 instead of a timeout.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callVisionModel, type Provider, type VisionRequest } from "../providers";
import { ExtractionError } from "../errors";
import { EXTRACTION_JSON_SCHEMA } from "../schema";

type Mode = "headers-then-stall" | "silent" | "prompt";

let mode: Mode;
let server: Server;
let origin: string;
/** Sockets left hanging on purpose; closed in afterEach so the suite can exit. */
let stalled: Array<() => void> = [];

const ENV_KEYS = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL",
  "EXTRACT_TIMEOUT_MS", "EXTRACTION_MODEL",
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (mode === "prompt") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }));
        return;
      }
      if (mode === "headers-then-stall") {
        // Exactly what OpenRouter does: 200 + headers now, body much later.
        res.writeHead(200, { "content-type": "application/json" });
        res.write(" ");
      }
      // "silent" writes nothing at all — not even headers.
      stalled.push(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.OPENAI_API_KEY = "test-openai";
  process.env.OPENAI_BASE_URL = `${origin}/v1`;
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  process.env.OPENROUTER_BASE_URL = `${origin}/api/v1`;
  process.env.EXTRACT_TIMEOUT_MS = "300";
  delete process.env.EXTRACTION_MODEL;
});

afterEach(() => {
  for (const close of stalled) close();
  stalled = [];
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

describe.each(["openai", "openrouter"] as Provider[])("%s", (provider) => {
  it("reports a 504, not a 502, when the body stalls after headers", async () => {
    mode = "headers-then-stall";
    const err = await callVisionModel(request(provider)).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).status).toBe(504);
    expect((err as ExtractionError).message).toMatch(/too long/i);
  });

  it("reports a 504 when nothing comes back at all", async () => {
    mode = "silent";
    const err = await callVisionModel(request(provider)).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as ExtractionError).status).toBe(504);
  });

  it("still succeeds when the model answers in time", async () => {
    mode = "prompt";
    const result = await callVisionModel(request(provider));
    expect(result.text).toBe("{}");
  });
});

it("EXTRACT_TIMEOUT_MS is respected", async () => {
  mode = "headers-then-stall";
  process.env.EXTRACT_TIMEOUT_MS = "900";
  const t0 = Date.now();
  await callVisionModel(request("openrouter")).catch(() => {});
  const elapsed = Date.now() - t0;
  process.env.EXTRACT_TIMEOUT_MS = "300";
  expect(elapsed).toBeGreaterThan(700);
  expect(elapsed).toBeLessThan(3000);
});
