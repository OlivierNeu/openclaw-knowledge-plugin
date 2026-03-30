// Unit tests for openclaw-knowledge plugin
// Uses Node.js built-in test runner (node:test) — zero dependencies.

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
  const original = { ...process.env };

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
// searchCollection
// ---------------------------------------------------------------------------

describe("searchCollection", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("returns mapped results on success", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        result: {
          points: [
            { score: 0.95, payload: { file_name: "doc.pdf", text: "hello" } },
            { score: 0.80, payload: { file_name: "notes.md", text: "world" } },
          ],
        },
      }),
    }));

    const results = await searchCollection(
      "knowledge_test",
      [0.1, 0.2],
      5,
      0.3,
      "http://qdrant:6333",
      ""
    );

    assert.equal(results.length, 2);
    assert.equal(results[0].collection, "knowledge_test");
    assert.equal(results[0].score, 0.95);
    assert.equal(results[0].file_name, "doc.pdf");
    assert.equal(results[1].text, "world");
  });

  it("sends correct request with API key", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      assert.equal(
        url,
        "http://localhost:6333/collections/my_col/points/query"
      );
      assert.equal(opts.headers["api-key"], "secret");

      const body = JSON.parse(opts.body);
      assert.equal(body.limit, 10);
      assert.equal(body.score_threshold, 0.5);
      assert.equal(body.with_payload, true);

      return {
        ok: true,
        json: async () => ({ result: { points: [] } }),
      };
    });

    await searchCollection(
      "my_col",
      [1, 2, 3],
      10,
      0.5,
      "http://localhost:6333",
      "secret"
    );
  });

  it("omits api-key header when no key provided", async () => {
    mock.method(globalThis, "fetch", async (_url, opts) => {
      assert.equal(opts.headers["api-key"], undefined);
      return {
        ok: true,
        json: async () => ({ result: { points: [] } }),
      };
    });

    await searchCollection("col", [1], 5, 0.3, "http://q:6333", "");
  });

  it("returns empty array on network error", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    const results = await searchCollection(
      "col",
      [1],
      5,
      0.3,
      "http://dead:6333",
      ""
    );
    assert.deepEqual(results, []);
  });

  it("returns empty array on non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 404,
    }));

    const results = await searchCollection(
      "nonexistent",
      [1],
      5,
      0.3,
      "http://q:6333",
      ""
    );
    assert.deepEqual(results, []);
  });

  it("handles missing result.points gracefully", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ result: {} }),
    }));

    const results = await searchCollection(
      "col",
      [1],
      5,
      0.3,
      "http://q:6333",
      ""
    );
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
    assert.equal(plugin.name, "Qdrant Knowledge Base");
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
    assert.equal(handlers["before_agent_start"], undefined);
  });

  it("registers before_agent_start hook when configured", () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        qdrantUrl: "http://localhost:6333",
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
    assert.equal(typeof handlers["before_agent_start"], "function");
  });

  it("skips short queries (less than 3 chars)", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        qdrantUrl: "http://localhost:6333",
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
      throw new Error("fetch should not be called");
    });

    plugin.register(api);

    const result = await handlers["before_agent_start"]({ prompt: "ab" });
    assert.equal(result, undefined);

    mock.restoreAll();
  });

  it("returns prependContext on successful search", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        qdrantUrl: "http://localhost:6333",
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
      if (url.includes("gemini")) {
        return {
          ok: true,
          json: async () => ({ embedding: { values: [0.1, 0.2] } }),
        };
      }
      // Qdrant
      return {
        ok: true,
        json: async () => ({
          result: {
            points: [
              { score: 0.9, payload: { file_name: "doc.pdf", text: "answer" } },
            ],
          },
        }),
      };
    });

    plugin.register(api);

    const result = await handlers["before_agent_start"]({
      prompt: "what is the answer?",
    });

    assert.ok(result.prependContext.includes("<relevant-memories>"));
    assert.ok(result.prependContext.includes("Knowledge Base Results"));
    assert.ok(result.prependContext.includes("doc.pdf"));
    assert.equal(callCount, 2); // 1 embed + 1 search

    mock.restoreAll();
  });


  it("does nothing when disabled", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        qdrantUrl: "http://localhost:6333",
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

    const result = await handlers["before_agent_start"]({
      prompt: "hello world query",
    });
    assert.equal(result, undefined);
  });
});
