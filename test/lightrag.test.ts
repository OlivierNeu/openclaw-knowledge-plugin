// Unit tests for the LightRAG client helpers.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  queryLightRAG,
  truncateLightRAG,
  parseLightRAGReferences,
} from "../src/lightrag.js";

describe("queryLightRAG", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("sends correct request to LightRAG API", async () => {
    mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      assert.equal(urlStr, "http://lightrag:9621/query");
      assert.equal(opts?.method, "POST");
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(headers["X-API-Key"], "my-api-key");

      const body = JSON.parse(opts?.body as string);
      assert.equal(body.query, "find my contracts");
      assert.equal(body.mode, "hybrid");
      assert.equal(body.only_need_context, true);
      assert.equal(body.stream, false);

      return {
        ok: true,
        json: async () => ({ response: "Contract A signed on 2025-01-01." }),
      } as unknown as Response;
    });

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "my-api-key",
      "find my contracts",
      "hybrid",
    );
    assert.equal(result.context, "Contract A signed on 2025-01-01.");
    assert.deepEqual(result.references, []);
  });

  it("returns empty context when response field is missing", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ other: "data" }),
    }) as unknown as Response);

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "",
      "query",
      "global",
    );
    assert.equal(result.context, "");
    assert.deepEqual(result.references, []);
  });

  it("falls back to the `context` field when `response` is absent", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ context: "via context field" }),
    }) as unknown as Response);

    const result = await queryLightRAG("http://lightrag:9621", "", "q", "hybrid");
    assert.equal(result.context, "via context field");
  });

  it("extracts structured source references from the response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Context with two sources.",
        references: [
          { reference_id: "1", file_path: "offre-1.md", content: "ignored body" },
          { reference_id: "2", file_path: "offre-2.md" },
        ],
      }),
    }) as unknown as Response);

    const result = await queryLightRAG("http://lightrag:9621", "", "q", "hybrid");
    assert.equal(result.context, "Context with two sources.");
    assert.deepEqual(result.references, [
      { file_path: "offre-1.md", reference_id: "1" },
      { file_path: "offre-2.md", reference_id: "2" },
    ]);
  });
});

describe("parseLightRAGReferences", () => {
  it("returns [] for non-array / missing input", () => {
    assert.deepEqual(parseLightRAGReferences(undefined), []);
    assert.deepEqual(parseLightRAGReferences(null), []);
    assert.deepEqual(parseLightRAGReferences("nope"), []);
    assert.deepEqual(parseLightRAGReferences({}), []);
  });

  it("keeps only entries with a non-empty string file_path", () => {
    const refs = parseLightRAGReferences([
      { reference_id: "1", file_path: "a.md" },
      { reference_id: "2", file_path: "" }, // empty → dropped
      { reference_id: "3" }, // no file_path → dropped
      { file_path: "b.md" }, // no reference_id → kept, id omitted
      "not-an-object", // → dropped
      null, // → dropped
      { file_path: 42 }, // non-string → dropped
    ]);
    assert.deepEqual(refs, [
      { file_path: "a.md", reference_id: "1" },
      { file_path: "b.md" },
    ]);
  });

  it("omits a non-string reference_id", () => {
    const refs = parseLightRAGReferences([{ reference_id: 5, file_path: "a.md" }]);
    assert.deepEqual(refs, [{ file_path: "a.md" }]);
  });

  it("omits X-API-Key header when no API key", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers["X-API-Key"], undefined);
      return { ok: true, json: async () => ({ response: "ok" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "hybrid");
  });

  it("uses provided query mode", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      assert.equal(body.mode, "global");
      return { ok: true, json: async () => ({ response: "" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "global");
  });

  it("defaults to hybrid mode when none specified", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      assert.equal(body.mode, "hybrid");
      return { ok: true, json: async () => ({ response: "" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query");
  });

  it("throws on non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as Response);

    await assert.rejects(
      () => queryLightRAG("http://lightrag:9621", "", "q", "hybrid"),
      { message: /LightRAG query failed \(500\)/ },
    );
  });
});

describe("truncateLightRAG", () => {
  it("returns empty string unchanged", () => {
    assert.equal(truncateLightRAG("", 100), "");
  });

  it("returns short text unchanged", () => {
    assert.equal(truncateLightRAG("short text.", 1000), "short text.");
  });

  it("truncates at last period when possible", () => {
    const text =
      "First sentence. Second sentence. Third sentence is very long.";
    const result = truncateLightRAG(text, 35);
    assert.equal(result, "First sentence. Second sentence.");
  });

  it("truncates at maxChars when no good period found", () => {
    const text = "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    assert.equal(result.length, 100);
  });

  it("does not cut at period too early in the text", () => {
    // Period at position 2 in a 100-char max — too early (< 50%)
    const text = "Hi. " + "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    // Should fall back to raw truncation since period is at pos 2 (< 50 = 50%)
    assert.equal(result.length, 100);
  });
});
