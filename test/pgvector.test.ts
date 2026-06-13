// Unit tests for the pgvector search helpers.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  searchCollection,
  formatPgvectorResults,
  formatPgvectorResultsDetailed,
  rerankPgvectorResults,
} from "../src/pgvector.js";
import type { PgPoolLike, PgvectorRow, PgvectorResult } from "../src/types.js";

function mockPool(rows: PgvectorRow[] = [], shouldThrow = false): PgPoolLike {
  return {
    query: async (_sql: string, _params: unknown[]) => {
      if (shouldThrow) throw new Error("connection refused");
      return { rows };
    },
  };
}

describe("searchCollection", () => {
  it("returns mapped results on success", async () => {
    const pool = mockPool([
      {
        file_name: "doc.pdf",
        text: "hello",
        score: "0.95",
        mime_type: "application/pdf",
        file_id: "abc",
        source: "google_drive",
        owner: "alice",
        chunk_index: 0,
        total_chunks: 1,
        timestamp_start: null,
        timestamp_end: null,
      },
      {
        file_name: "notes.md",
        text: "world",
        score: "0.80",
        mime_type: "text/markdown",
        file_id: "def",
        source: "google_drive",
        owner: "alice",
        chunk_index: 0,
        total_chunks: 1,
        timestamp_start: null,
        timestamp_end: null,
      },
    ]);

    const results = await searchCollection(
      pool,
      "knowledge_test",
      [0.1, 0.2],
      5,
      0.3,
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]!.collection, "knowledge_test");
    assert.equal(results[0]!.score, 0.95);
    assert.equal(results[0]!.file_name, "doc.pdf");
    assert.equal(results[1]!.text, "world");
  });

  it("sends correct SQL with halfvec cast", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool: PgPoolLike = {
      query: async (sql, params) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] };
      },
    };

    await searchCollection(pool, "my_col", [1, 2, 3], 10, 0.5);

    assert.ok(capturedSql.includes("halfvec(3072)"));
    assert.ok(capturedSql.includes("knowledge_vectors"));
    assert.equal(capturedParams[0], "[1,2,3]");
    assert.equal(capturedParams[1], "my_col");
    assert.equal(capturedParams[2], 10);
  });

  it("filters results below score threshold", async () => {
    const pool = mockPool([
      { file_name: "good.pdf", score: "0.8", text: "yes" },
      { file_name: "bad.pdf", score: "0.1", text: "no" },
    ]);

    const results = await searchCollection(pool, "col", [1], 5, 0.5);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.file_name, "good.pdf");
  });

  it("propagates the database error (v3.2.3 — Codex pass #28 P2)", async () => {
    // v3.2.3 stopped swallowing pg errors so the caller can distinguish
    // "ran and matched nothing" from "the SQL layer broke" in telemetry.
    // The plugin's `runPgvectorSource` uses `Promise.allSettled` to keep
    // graceful degradation across multiple collections.
    const pool = mockPool([], true);
    await assert.rejects(
      searchCollection(pool, "col", [1], 5, 0.3),
      /connection refused/,
    );
  });

  it("handles empty result set", async () => {
    const pool = mockPool([]);

    const results = await searchCollection(pool, "col", [1], 5, 0.3);
    assert.deepEqual(results, []);
  });
});

describe("formatPgvectorResults", () => {
  // Public API — signature is `(results, maxChars): string | null` and MUST
  // stay stable across v3.x. Callers needing the count of entries actually
  // injected use the internal `formatPgvectorResultsDetailed` variant
  // (covered by the next `describe` block).
  it("returns null for empty results", () => {
    assert.equal(formatPgvectorResults([], 4000), null);
  });

  it("formats basic result with score and file name", () => {
    const results: PgvectorResult[] = [
      {
        collection: "knowledge",
        score: 0.95,
        file_name: "doc.pdf",
        text: "hello",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    const formatted = formatPgvectorResults(results, 4000);

    assert.ok(formatted !== null);
    assert.ok(formatted!.includes("[knowledge] doc.pdf (score: 0.95)"));
    assert.ok(formatted!.includes("Content: hello"));
  });

  it("shows 'unknown' when file_name is missing", () => {
    const results: PgvectorResult[] = [
      {
        collection: "col",
        score: 0.5,
        text: "data",
        file_name: null,
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    const formatted = formatPgvectorResults(results, 4000);

    assert.ok(formatted!.includes("[col] unknown (score: 0.50)"));
  });

  it("includes timestamps when present", () => {
    const results: PgvectorResult[] = [
      {
        collection: "videos",
        score: 0.88,
        file_name: "meeting.mp4",
        timestamp_start: "00:05:30",
        timestamp_end: "00:06:15",
        text: "important discussion",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
      },
    ];
    const formatted = formatPgvectorResults(results, 4000);

    assert.ok(formatted!.includes("Segment: 00:05:30 - 00:06:15"));
  });

  it("respects maxChars limit", () => {
    const results: PgvectorResult[] = Array.from({ length: 100 }, (_, i) => ({
      collection: "col",
      score: 0.9,
      file_name: `file${i}.pdf`,
      text: "x".repeat(100),
      mime_type: null,
      file_id: null,
      source: null,
      owner: null,
      chunk_index: null,
      total_chunks: null,
      timestamp_start: null,
      timestamp_end: null,
    }));

    const formatted = formatPgvectorResults(results, 500);
    assert.ok(formatted !== null);
    assert.ok(formatted!.length <= 500);
  });

  it("includes multiple results in order", () => {
    const results: PgvectorResult[] = [
      {
        collection: "a",
        score: 0.9,
        file_name: "first.pdf",
        text: "aaa",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
      {
        collection: "b",
        score: 0.8,
        file_name: "second.pdf",
        text: "bbb",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    const formatted = formatPgvectorResults(results, 4000);

    const firstIdx = formatted!.indexOf("first.pdf");
    const secondIdx = formatted!.indexOf("second.pdf");
    assert.ok(firstIdx < secondIdx);
  });

  it("returns null when even the first entry exceeds the budget", () => {
    // Pre-v3.2.5 the helper returned `""` (falsy) so the caller's
    // `if (!formatted)` skipped injection. The internal Detailed variant
    // explicitly returns null in this case; the public wrapper inherits
    // that behavior via `?.output ?? null`. Documented here so a future
    // refactor cannot silently regress the "skip when nothing fits"
    // semantics.
    const results: PgvectorResult[] = [
      {
        collection: "col",
        score: 0.9,
        file_name: "huge.pdf",
        text: "x".repeat(1000),
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    assert.equal(formatPgvectorResults(results, 50), null);
  });
});

describe("formatPgvectorResultsDetailed", () => {
  // Internal variant — exposes `injectedCount` so the plugin's render path
  // can size the provenance report exactly to what reached the LLM
  // (PROVENANCE_CONTRACT: "emit what was injected, not what was retrieved").
  it("returns null for empty results", () => {
    assert.equal(formatPgvectorResultsDetailed([], 4000), null);
  });

  it("reports injectedCount === results.length when the budget is not hit", () => {
    const results: PgvectorResult[] = [
      {
        collection: "a",
        score: 0.9,
        file_name: "first.pdf",
        text: "aaa",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
      {
        collection: "b",
        score: 0.8,
        file_name: "second.pdf",
        text: "bbb",
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    const detailed = formatPgvectorResultsDetailed(results, 4000);
    assert.ok(detailed !== null);
    assert.equal(detailed!.injectedCount, 2);
    assert.ok(detailed!.output.includes("first.pdf"));
    assert.ok(detailed!.output.includes("second.pdf"));
  });

  it("truncates and reports a strictly smaller injectedCount when budget bites", () => {
    const results: PgvectorResult[] = Array.from({ length: 100 }, (_, i) => ({
      collection: "col",
      score: 0.9,
      file_name: `file${i}.pdf`,
      text: "x".repeat(100),
      mime_type: null,
      file_id: null,
      source: null,
      owner: null,
      chunk_index: null,
      total_chunks: null,
      timestamp_start: null,
      timestamp_end: null,
    }));

    const detailed = formatPgvectorResultsDetailed(results, 500);
    assert.ok(detailed !== null);
    assert.ok(detailed!.output.length <= 500);
    // `injectedCount` MUST be strictly less than the input length whenever
    // the budget bites — this is exactly the assertion the provenance
    // contract relies on to slice `result.data` accurately.
    assert.ok(detailed!.injectedCount > 0);
    assert.ok(detailed!.injectedCount < results.length);
  });

  it("returns null when even the first entry exceeds the budget", () => {
    // Same regression guard as the public wrapper — kept here so the
    // Detailed-shape contract is pinned independently.
    const results: PgvectorResult[] = [
      {
        collection: "col",
        score: 0.9,
        file_name: "huge.pdf",
        text: "x".repeat(1000),
        mime_type: null,
        file_id: null,
        source: null,
        owner: null,
        chunk_index: null,
        total_chunks: null,
        timestamp_start: null,
        timestamp_end: null,
      },
    ];
    assert.equal(formatPgvectorResultsDetailed(results, 50), null);
  });
});

describe("rerankPgvectorResults (v3.2.0)", () => {
  afterEach(() => mock.restoreAll());

  function makeResult(file: string, text: string | null, score: number): PgvectorResult {
    return {
      collection: "col",
      score,
      file_name: file,
      text,
      mime_type: null,
      file_id: null,
      source: null,
      owner: null,
      chunk_index: null,
      total_chunks: null,
      timestamp_start: null,
      timestamp_end: null,
    };
  }

  it("returns [] for empty input without hitting the network", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const out = await rerankPgvectorResults([], {
      apiKey: "k",
      query: "q",
    });
    assert.deepEqual(out, []);
    assert.equal(fetchCalled, false);
  });

  it("re-orders results using the reranker's index map", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 2, relevance_score: 0.95 },
            { index: 0, relevance_score: 0.60 },
            { index: 1, relevance_score: 0.20 },
          ],
        }),
        { status: 200 },
      ),
    );

    const inputs = [
      makeResult("A.pdf", "text A", 0.5),
      makeResult("B.pdf", "text B", 0.6),
      makeResult("C.pdf", "text C", 0.4),
    ];
    const out = await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "find",
    });

    assert.equal(out.length, 3);
    assert.equal(out[0]!.file_name, "C.pdf");
    assert.equal(out[1]!.file_name, "A.pdf");
    assert.equal(out[2]!.file_name, "B.pdf");
    // Original cosine score is preserved (we only re-order, not re-score).
    assert.equal(out[0]!.score, 0.4);
  });

  it("filters out rows with null/empty text BEFORE calling the reranker", async () => {
    let capturedBody: Record<string, unknown> = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200 },
      );
    });

    const inputs = [
      makeResult("good.pdf", "real text", 0.5),
      makeResult("blank.pdf", "", 0.4),
      makeResult("null.pdf", null, 0.3),
    ];

    await rerankPgvectorResults(inputs, { apiKey: "k", query: "find" });

    // Only the row with non-empty text should reach Jina.
    assert.deepEqual(capturedBody["documents"], ["real text"]);
  });

  it("falls back to cosine order when the reranker returns an empty result set", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    const inputs = [
      makeResult("A.pdf", "text A", 0.9),
      makeResult("B.pdf", "text B", 0.5),
    ];
    const out = await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "find",
      topN: 1,
    });

    // topN truncates to 1, in original order.
    assert.equal(out.length, 1);
    assert.equal(out[0]!.file_name, "A.pdf");
  });

  it("propagates Jina errors so the caller can update its cooldown", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("rate limited", { status: 429 }),
    );

    const inputs = [makeResult("A.pdf", "text", 0.5)];
    await assert.rejects(
      () => rerankPgvectorResults(inputs, { apiKey: "k", query: "q" }),
      (err: unknown) => err instanceof Error && err.message.includes("429"),
    );
  });

  // -------------------------------------------------------------------------
  // v3.2.4 payload-size guards
  // -------------------------------------------------------------------------

  it("caps the candidate pool at candidatePoolMax before submission", async () => {
    let submitted: string[] = [];
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string) as { documents: string[] };
      submitted = body.documents;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200 },
      );
    });

    // 30 candidates, cap at 10 → only the first 10 reach Jina.
    const inputs = Array.from({ length: 30 }, (_, i) =>
      makeResult(`doc-${i}.pdf`, `text ${i}`, 0.9 - i * 0.01),
    );
    await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "q",
      candidatePoolMax: 10,
    });
    assert.equal(submitted.length, 10);
    // First 10 in cosine order (already sorted by the caller).
    assert.equal(submitted[0], "text 0");
    assert.equal(submitted[9], "text 9");
  });

  it("truncates each candidate to maxCharsPerDoc before submission", async () => {
    let submitted: string[] = [];
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string) as { documents: string[] };
      submitted = body.documents;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200 },
      );
    });

    const longText = "x".repeat(8000); // > 2000
    const inputs = [makeResult("A.pdf", longText, 0.5)];
    await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "q",
      maxCharsPerDoc: 1500,
    });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]!.length, 1500);
  });

  it("calls onUsage with inputCount + totalChars + duration after a successful call", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          results: [
            { index: 0, relevance_score: 0.9 },
            { index: 1, relevance_score: 0.7 },
          ],
        }),
        { status: 200 },
      ),
    );

    const usageCalls: Array<{ inputCount: number; totalChars: number; durationMs: number }> = [];
    const inputs = [
      makeResult("A.pdf", "abcdef", 0.5), // 6 chars
      makeResult("B.pdf", "ghijklmn", 0.4), // 8 chars
    ];
    await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "q",
      onUsage: (u) => usageCalls.push(u),
    });

    assert.equal(usageCalls.length, 1);
    assert.equal(usageCalls[0]!.inputCount, 2);
    assert.equal(usageCalls[0]!.totalChars, 14);
    assert.ok(usageCalls[0]!.durationMs >= 0);
  });

  it("does NOT call onUsage when the call fails", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("server down", { status: 503 }),
    );

    const usageCalls: number[] = [];
    const inputs = [makeResult("A.pdf", "text", 0.5)];
    await assert.rejects(
      () =>
        rerankPgvectorResults(inputs, {
          apiKey: "k",
          query: "q",
          onUsage: (u) => usageCalls.push(u.inputCount),
        }),
    );
    assert.equal(usageCalls.length, 0);
  });

  it("with candidatePoolMax=0 or maxCharsPerDoc=0 keeps legacy behavior (no trim)", async () => {
    let submitted: string[] = [];
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string) as { documents: string[] };
      submitted = body.documents;
      return new Response(
        JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200 },
      );
    });

    const inputs = Array.from({ length: 5 }, (_, i) =>
      makeResult(`doc-${i}.pdf`, "x".repeat(5000), 0.9 - i * 0.01),
    );
    // The resolver passes `undefined` to the helper when the config is 0 —
    // simulate that here directly.
    await rerankPgvectorResults(inputs, {
      apiKey: "k",
      query: "q",
      candidatePoolMax: undefined,
      maxCharsPerDoc: undefined,
    });
    assert.equal(submitted.length, 5);
    assert.equal(submitted[0]!.length, 5000);
  });
});
