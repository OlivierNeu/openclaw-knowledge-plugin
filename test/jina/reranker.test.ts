// Unit tests for the Jina Reranker client.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { rerank, parseRerankResponse } from "../../src/jina/reranker.js";

describe("rerank — request shape", () => {
  afterEach(() => mock.restoreAll());

  it("posts to /v1/rerank with query, documents, hardcoded return_documents=false", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};

    mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(opts?.body as string);
      capturedHeaders = opts?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.97 },
            { index: 0, relevance_score: 0.51 },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await rerank({
      apiKey: "jina_test",
      query: "ennéagramme exercice",
      documents: ["doc A", "doc B", "doc C"],
      topN: 2,
    });

    assert.equal(capturedUrl, "https://api.jina.ai/v1/rerank");
    assert.equal(capturedHeaders["Authorization"], "Bearer jina_test");
    assert.equal(capturedBody["model"], "jina-reranker-v2-base-multilingual");
    assert.equal(capturedBody["query"], "ennéagramme exercice");
    assert.deepEqual(capturedBody["documents"], ["doc A", "doc B", "doc C"]);
    assert.equal(capturedBody["return_documents"], false);
    assert.equal(capturedBody["truncate"], true);
    assert.equal(capturedBody["top_n"], 2);

    assert.deepEqual(result, [
      { index: 2, score: 0.97 },
      { index: 0, score: 0.51 },
    ]);
  });

  it("omits top_n when not provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    await rerank({ apiKey: "k", query: "q", documents: ["a"] });
    assert.equal(capturedBody["top_n"], undefined);
  });

  it("allows overriding the reranker model", async () => {
    let capturedBody: Record<string, unknown> = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });

    await rerank({
      apiKey: "k",
      query: "q",
      documents: ["a"],
      model: "jina-reranker-v3",
    });
    assert.equal(capturedBody["model"], "jina-reranker-v3");
  });

  it("returns [] without hitting the network when documents is empty", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const out = await rerank({ apiKey: "k", query: "q", documents: [] });
    assert.deepEqual(out, []);
    assert.equal(fetchCalled, false);
  });
});

describe("parseRerankResponse — defensive parsing", () => {
  it("parses canonical shape with relevance_score", () => {
    const r = parseRerankResponse(
      { results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.3 }] },
      2,
    );
    assert.deepEqual(r, [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.3 },
    ]);
  });

  it("accepts score as an alias for relevance_score", () => {
    const r = parseRerankResponse({ results: [{ index: 0, score: 0.42 }] }, 1);
    assert.deepEqual(r, [{ index: 0, score: 0.42 }]);
  });

  it("returns [] for an empty or malformed response", () => {
    assert.deepEqual(parseRerankResponse({}, 5), []);
    assert.deepEqual(parseRerankResponse(null, 5), []);
    assert.deepEqual(parseRerankResponse("oops", 5), []);
    assert.deepEqual(parseRerankResponse({ results: "not an array" }, 5), []);
    assert.deepEqual(parseRerankResponse({ results: [] }, 5), []);
  });

  it("skips items with out-of-range index", () => {
    const r = parseRerankResponse(
      { results: [{ index: 99, score: 0.5 }, { index: -1, score: 0.4 }, { index: 0, score: 0.3 }] },
      3,
    );
    assert.deepEqual(r, [{ index: 0, score: 0.3 }]);
  });

  it("skips items missing score", () => {
    const r = parseRerankResponse({ results: [{ index: 0 }, { index: 1, score: 0.5 }] }, 2);
    assert.deepEqual(r, [{ index: 1, score: 0.5 }]);
  });

  it("skips items with non-finite scores (NaN, Infinity)", () => {
    const r = parseRerankResponse(
      { results: [{ index: 0, score: NaN }, { index: 1, score: Infinity }, { index: 2, score: 0.5 }] },
      3,
    );
    assert.deepEqual(r, [{ index: 2, score: 0.5 }]);
  });
});
