// Unit tests for the pgvector search helpers.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  searchCollection,
  formatPgvectorResults,
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
        owner: "olivier",
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
        owner: "olivier",
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

  it("returns empty array on database error", async () => {
    const pool = mockPool([], true);

    const results = await searchCollection(pool, "col", [1], 5, 0.3);
    assert.deepEqual(results, []);
  });

  it("handles empty result set", async () => {
    const pool = mockPool([]);

    const results = await searchCollection(pool, "col", [1], 5, 0.3);
    assert.deepEqual(results, []);
  });
});

describe("formatPgvectorResults", () => {
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
    const output = formatPgvectorResults(results, 4000);

    assert.ok(output !== null);
    assert.ok(output!.includes("[knowledge] doc.pdf (score: 0.95)"));
    assert.ok(output!.includes("Content: hello"));
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
    const output = formatPgvectorResults(results, 4000);

    assert.ok(output!.includes("[col] unknown (score: 0.50)"));
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
    const output = formatPgvectorResults(results, 4000);

    assert.ok(output!.includes("Segment: 00:05:30 - 00:06:15"));
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

    const output = formatPgvectorResults(results, 500);
    assert.ok(output!.length <= 500);
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
    const output = formatPgvectorResults(results, 4000);

    const firstIdx = output!.indexOf("first.pdf");
    const secondIdx = output!.indexOf("second.pdf");
    assert.ok(firstIdx < secondIdx);
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
});
