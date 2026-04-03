// Unit tests for openclaw-knowledge plugin (pgvector version)
// Uses Node.js built-in test runner (node:test) — zero test dependencies.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import plugin, {
  resolveEnv,
  embedQuery,
  searchCollection,
  formatResults,
} from "./index.js";

// ---------------------------------------------------------------------------
// resolveEnv
// ---------------------------------------------------------------------------

describe("resolveEnv", () => {
  beforeEach(() => {
    process.env.TEST_KEY = "hello";
    process.env.OTHER_KEY = "world";
  });

  afterEach(() => {
    delete process.env.TEST_KEY;
    delete process.env.OTHER_KEY;
  });

  it("returns non-string values as-is", () => {
    assert.equal(resolveEnv(42), 42);
    assert.equal(resolveEnv(null), null);
    assert.equal(resolveEnv(undefined), undefined);
    assert.equal(resolveEnv(true), true);
  });

  it("replaces ${VAR} with env value", () => {
    assert.equal(resolveEnv("${TEST_KEY}"), "hello");
  });

  it("replaces multiple variables", () => {
    assert.equal(resolveEnv("${TEST_KEY}-${OTHER_KEY}"), "hello-world");
  });

  it("replaces missing variables with empty string", () => {
    assert.equal(resolveEnv("${NONEXISTENT_VAR}"), "");
  });

  it("returns plain strings unchanged", () => {
    assert.equal(resolveEnv("no vars here"), "no vars here");
  });
});

// ---------------------------------------------------------------------------
// embedQuery
// ---------------------------------------------------------------------------

describe("embedQuery", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("returns embedding values on success", async () => {
    const fakeValues = [0.1, 0.2, 0.3];

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ embedding: { values: fakeValues } }),
    }));

    const result = await embedQuery("test query", "fake-key");
    assert.deepEqual(result, fakeValues);
  });

  it("sends correct request to Gemini API", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      assert.ok(url.includes("gemini-embedding-2-preview:embedContent"));
      assert.ok(url.includes("key=my-key"));
      assert.equal(opts.method, "POST");

      const body = JSON.parse(opts.body);
      assert.equal(body.content.parts[0].text, "hello world");

      return {
        ok: true,
        json: async () => ({ embedding: { values: [1] } }),
      };
    });

    await embedQuery("hello world", "my-key");
    assert.equal(globalThis.fetch.mock.callCount(), 1);
  });

  it("throws on non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }));

    await assert.rejects(() => embedQuery("q", "k"), {
      message: /Gemini embedding failed \(429\)/,
    });
  });
});

// ---------------------------------------------------------------------------
// searchCollection (pgvector)
// ---------------------------------------------------------------------------

describe("searchCollection", () => {
  function mockPool(rows = [], shouldThrow = false) {
    return {
      query: async (sql, params) => {
        if (shouldThrow) throw new Error("connection refused");
        return { rows };
      },
    };
  }

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
      0.3
    );

    assert.equal(results.length, 2);
    assert.equal(results[0].collection, "knowledge_test");
    assert.equal(results[0].score, 0.95);
    assert.equal(results[0].file_name, "doc.pdf");
    assert.equal(results[1].text, "world");
  });

  it("sends correct SQL with halfvec cast", async () => {
    let capturedSql = "";
    let capturedParams = [];
    const pool = {
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

    const results = await searchCollection(
      pool,
      "col",
      [1],
      5,
      0.5
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].file_name, "good.pdf");
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

// ---------------------------------------------------------------------------
// formatResults
// ---------------------------------------------------------------------------

describe("formatResults", () => {
  it("returns null for empty results", () => {
    assert.equal(formatResults([], 4000), null);
  });

  it("formats basic result with score and file name", () => {
    const results = [
      { collection: "knowledge", score: 0.95, file_name: "doc.pdf", text: "hello" },
    ];
    const output = formatResults(results, 4000);

    assert.ok(output.includes("[knowledge] doc.pdf (score: 0.95)"));
    assert.ok(output.includes("Content: hello"));
  });

  it("shows 'unknown' when file_name is missing", () => {
    const results = [{ collection: "col", score: 0.5, text: "data" }];
    const output = formatResults(results, 4000);

    assert.ok(output.includes("[col] unknown (score: 0.50)"));
  });

  it("includes timestamps when present", () => {
    const results = [
      {
        collection: "videos",
        score: 0.88,
        file_name: "meeting.mp4",
        timestamp_start: "00:05:30",
        timestamp_end: "00:06:15",
        text: "important discussion",
      },
    ];
    const output = formatResults(results, 4000);

    assert.ok(output.includes("Segment: 00:05:30 - 00:06:15"));
  });

  it("respects maxChars limit", () => {
    const results = Array.from({ length: 100 }, (_, i) => ({
      collection: "col",
      score: 0.9,
      file_name: `file${i}.pdf`,
      text: "x".repeat(100),
    }));

    const output = formatResults(results, 500);
    assert.ok(output.length <= 500);
  });

  it("includes multiple results in order", () => {
    const results = [
      { collection: "a", score: 0.9, file_name: "first.pdf", text: "aaa" },
      { collection: "b", score: 0.8, file_name: "second.pdf", text: "bbb" },
    ];
    const output = formatResults(results, 4000);

    const firstIdx = output.indexOf("first.pdf");
    const secondIdx = output.indexOf("second.pdf");
    assert.ok(firstIdx < secondIdx);
  });
});

// ---------------------------------------------------------------------------
// register (integration)
// ---------------------------------------------------------------------------

describe("register", () => {
  it("exposes correct plugin metadata", () => {
    assert.equal(plugin.id, "openclaw-knowledge");
    assert.equal(plugin.name, "pgvector Knowledge Base");
  });

  it("warns and returns when geminiApiKey is missing", () => {
    const warnings = [];
    const handlers = {};
    const api = {
      pluginConfig: {},
      logger: {
        warn: (msg) => warnings.push(msg),
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("GEMINI_API_KEY not configured"));
    assert.equal(handlers["before_prompt_build"], undefined);
  });

  it("registers before_prompt_build hook when configured", () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["test_col"],
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    assert.equal(typeof handlers["before_prompt_build"], "function");
  });

  it("skips short queries (less than 3 chars)", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called for embed");
    });

    plugin.register(api);

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "ab" }],
    });
    assert.equal(result, undefined);

    mock.restoreAll();
  });

  it("does nothing when disabled", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
        enabled: false,
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "hello world query" }],
    });
    assert.equal(result, undefined);
  });

  it("extracts query from array content format (OpenClaw multi-part)", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    let callCount = 0;
    mock.method(globalThis, "fetch", async (url) => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ embedding: { values: [0.1, 0.2] } }),
      };
    });

    plugin.register(api);

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in my scanned documents?" },
          ],
        },
      ],
    });

    // Gemini embedding should have been called (query was extracted)
    assert.ok(callCount >= 1, "fetch should be called for embedding");

    mock.restoreAll();
  });

  it("handles mixed content array with non-text parts", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called for empty text");
    });

    plugin.register(api);

    // Content array with only non-text parts -> query should be empty
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: "base64..." },
          ],
        },
      ],
    });

    assert.equal(result, undefined);
    mock.restoreAll();
  });

  it("skips system messages in array content", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    let callCount = 0;
    mock.method(globalThis, "fetch", async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ embedding: { values: [0.1] } }),
      };
    });

    plugin.register(api);

    // Last message is assistant, user message is second-to-last (array format)
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "System: WhatsApp connected.\n\nFind my documents" },
          ],
        },
        {
          role: "assistant",
          content: "I'll look for your documents.",
        },
      ],
    });

    // Should have called embedding with the user's message
    assert.ok(callCount >= 1);
    mock.restoreAll();
  });
});
