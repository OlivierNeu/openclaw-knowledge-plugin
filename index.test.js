// Unit tests for openclaw-knowledge plugin (pgvector + LightRAG)
// Uses Node.js built-in test runner (node:test) — zero test dependencies.

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import plugin, {
  resolveEnv,
  embedQuery,
  searchCollection,
  formatResults,
  queryLightRAG,
  truncateLightRAG,
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

    const results = await searchCollection(pool, "col", [1], 5, 0.5);

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
      {
        collection: "knowledge",
        score: 0.95,
        file_name: "doc.pdf",
        text: "hello",
      },
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
// queryLightRAG
// ---------------------------------------------------------------------------

describe("queryLightRAG", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("sends correct request to LightRAG API", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      assert.equal(url, "http://lightrag:9621/query");
      assert.equal(opts.method, "POST");
      assert.equal(opts.headers["Content-Type"], "application/json");
      assert.equal(opts.headers["Authorization"], "Bearer my-api-key");

      const body = JSON.parse(opts.body);
      assert.equal(body.query, "find my contracts");
      assert.equal(body.mode, "hybrid");
      assert.equal(body.only_need_context, true);
      assert.equal(body.stream, false);

      return {
        ok: true,
        json: async () => ({ response: "Contract A signed on 2025-01-01." }),
      };
    });

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "my-api-key",
      "find my contracts",
      "hybrid"
    );
    assert.equal(result, "Contract A signed on 2025-01-01.");
  });

  it("handles string response format", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => "Direct string context from LightRAG",
    }));

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "",
      "query",
      "naive"
    );
    assert.equal(result, "Direct string context from LightRAG");
  });

  it("handles response with context field", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ context: "Context field data" }),
    }));

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "",
      "query",
      "local"
    );
    assert.equal(result, "Context field data");
  });

  it("returns empty string for unexpected response shape", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ other: "data" }),
    }));

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "",
      "query",
      "global"
    );
    assert.equal(result, "");
  });

  it("omits Authorization header when no API key", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      assert.equal(opts.headers["Authorization"], undefined);
      return { ok: true, json: async () => ({ response: "ok" }) };
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "hybrid");
  });

  it("uses provided query mode", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.mode, "global");
      return { ok: true, json: async () => ({ response: "" }) };
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "global");
  });

  it("defaults to hybrid mode when none specified", async () => {
    mock.method(globalThis, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.mode, "hybrid");
      return { ok: true, json: async () => ({ response: "" }) };
    });

    await queryLightRAG("http://lightrag:9621", "", "query");
  });

  it("throws on non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }));

    await assert.rejects(
      () => queryLightRAG("http://lightrag:9621", "", "q", "hybrid"),
      { message: /LightRAG query failed \(500\)/ }
    );
  });
});

// ---------------------------------------------------------------------------
// truncateLightRAG
// ---------------------------------------------------------------------------

describe("truncateLightRAG", () => {
  it("returns null/empty values unchanged", () => {
    assert.equal(truncateLightRAG(null, 100), null);
    assert.equal(truncateLightRAG("", 100), "");
  });

  it("returns short text unchanged", () => {
    assert.equal(truncateLightRAG("short text.", 1000), "short text.");
  });

  it("truncates at last period when possible", () => {
    const text = "First sentence. Second sentence. Third sentence is very long.";
    const result = truncateLightRAG(text, 35);
    assert.equal(result, "First sentence. Second sentence.");
  });

  it("truncates at maxChars when no good period found", () => {
    const text = "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    assert.equal(result.length, 100);
  });

  it("does not cut at period too early in the text", () => {
    // Period at position 5 in a 100-char max — too early (< 50%)
    const text = "Hi. " + "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    // Should fall back to raw truncation since period is at pos 2 (< 50 = 50%)
    assert.equal(result.length, 100);
  });
});

// ---------------------------------------------------------------------------
// register — plugin metadata
// ---------------------------------------------------------------------------

describe("register", () => {
  it("exposes correct plugin metadata", () => {
    assert.equal(plugin.id, "openclaw-knowledge");
    assert.equal(plugin.name, "Knowledge Base");
    assert.equal(typeof plugin.description, "string");
    assert.ok(plugin.description.includes("pgvector"));
    assert.ok(plugin.description.includes("LightRAG"));
  });

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  it("warns and returns when neither pgvector nor lightrag configured", () => {
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
    assert.ok(warnings[0].includes("neither pgvector nor LightRAG configured"));
    assert.equal(handlers["before_prompt_build"], undefined);
  });

  it("registers hook with pgvector only", () => {
    const infos = [];
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["test_col"],
      },
      logger: {
        warn: () => {},
        info: (msg) => infos.push(msg),
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    assert.equal(typeof handlers["before_prompt_build"], "function");
    assert.ok(infos.some((m) => m.includes("pgvector")));
    assert.ok(!infos.some((m) => m.includes("LightRAG")));
  });

  it("registers hook with lightrag only", () => {
    const infos = [];
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
        lightragApiKey: "lr-key",
      },
      logger: {
        warn: () => {},
        info: (msg) => infos.push(msg),
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    assert.equal(typeof handlers["before_prompt_build"], "function");
    assert.ok(infos.some((m) => m.includes("LightRAG")));
    assert.ok(!infos.some((m) => m.includes("pgvector")));
  });

  it("registers hook with both sources", () => {
    const infos = [];
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
        collections: ["col"],
        lightragUrl: "http://lightrag:9621",
      },
      logger: {
        warn: () => {},
        info: (msg) => infos.push(msg),
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    assert.equal(typeof handlers["before_prompt_build"], "function");
    const readyMsg = infos.find((m) => m.includes("ready"));
    assert.ok(readyMsg.includes("pgvector"));
    assert.ok(readyMsg.includes("LightRAG"));
  });

  it("disables pgvector when pgvectorEnabled is false", () => {
    const infos = [];
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://localhost/knowledge",
        pgvectorEnabled: false,
        lightragUrl: "http://lightrag:9621",
      },
      logger: {
        warn: () => {},
        info: (msg) => infos.push(msg),
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    const readyMsg = infos.find((m) => m.includes("ready"));
    assert.ok(!readyMsg.includes("pgvector"));
    assert.ok(readyMsg.includes("LightRAG"));
  });

  it("disables lightrag when lightragEnabled is false", () => {
    const infos = [];
    const handlers = {};
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://localhost/knowledge",
        lightragUrl: "http://lightrag:9621",
        lightragEnabled: false,
      },
      logger: {
        warn: () => {},
        info: (msg) => infos.push(msg),
        debug: () => {},
        error: () => {},
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    plugin.register(api);
    const readyMsg = infos.find((m) => m.includes("ready"));
    assert.ok(readyMsg.includes("pgvector"));
    assert.ok(!readyMsg.includes("LightRAG"));
  });

  // -----------------------------------------------------------------------
  // Hook: query extraction
  // -----------------------------------------------------------------------

  it("skips short queries (less than 3 chars)", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "ab" }],
    });
    assert.equal(result, undefined);
    mock.restoreAll();
  });

  it("skips empty messages array", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [],
    });
    assert.equal(result, undefined);
    mock.restoreAll();
  });

  it("does nothing when disabled", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

  it("extracts query from string content", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      capturedQuery = body.query;
      return {
        ok: true,
        json: async () => ({ response: "context" }),
      };
    });

    plugin.register(api);
    await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "find my contracts" }],
    });

    assert.equal(capturedQuery, "find my contracts");
    mock.restoreAll();
  });

  it("extracts query from array content format (OpenClaw multi-part)", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      capturedQuery = body.query;
      return {
        ok: true,
        json: async () => ({ response: "context" }),
      };
    });

    plugin.register(api);
    await handlers["before_prompt_build"]({
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

    assert.equal(capturedQuery, "what is in my scanned documents?");
    mock.restoreAll();
  });

  it("handles mixed content array with non-text parts", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "base64..." }],
        },
      ],
    });

    assert.equal(result, undefined);
    mock.restoreAll();
  });

  it("picks last user message, skipping assistant messages", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (url, opts) => {
      const body = JSON.parse(opts.body);
      capturedQuery = body.query;
      return { ok: true, json: async () => ({ response: "ctx" }) };
    });

    plugin.register(api);
    await handlers["before_prompt_build"]({
      prompt: "",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    });

    assert.equal(capturedQuery, "second question");
    mock.restoreAll();
  });

  // -----------------------------------------------------------------------
  // Hook: LightRAG-only execution
  // -----------------------------------------------------------------------

  it("injects LightRAG context into appendSystemContext", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
        lightragApiKey: "lr-key",
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

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Entity: ACME Corp. Relation: signed contract with Olivier.",
      }),
    }));

    plugin.register(api);
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "tell me about ACME" }],
    });

    assert.ok(result.appendSystemContext.includes("Knowledge Graph Context (LightRAG)"));
    assert.ok(result.appendSystemContext.includes("ACME Corp"));
    assert.ok(result.appendSystemContext.includes("Relevant Knowledge Base"));
    mock.restoreAll();
  });

  it("returns undefined when LightRAG returns empty context", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
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

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "" }),
    }));

    plugin.register(api);
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "something obscure" }],
    });

    assert.equal(result, undefined);
    mock.restoreAll();
  });

  it("truncates LightRAG context to lightragMaxChars", async () => {
    const handlers = {};
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
        lightragMaxChars: 50,
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

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "A".repeat(200) }),
    }));

    plugin.register(api);
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "long context query" }],
    });

    assert.ok(result.appendSystemContext.length < 300);
    mock.restoreAll();
  });

  // -----------------------------------------------------------------------
  // Hook: graceful degradation
  // -----------------------------------------------------------------------

  it("continues with LightRAG when pgvector fails", async () => {
    const handlers = {};
    const errors = [];
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://localhost/knowledge",
        lightragUrl: "http://lightrag:9621",
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: (msg) => errors.push(msg),
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    let fetchCallCount = 0;
    mock.method(globalThis, "fetch", async (url) => {
      fetchCallCount++;
      if (url.includes("generativelanguage")) {
        // Gemini embedding fails
        return { ok: false, status: 500, text: async () => "embed error" };
      }
      // LightRAG succeeds
      return {
        ok: true,
        json: async () => ({ response: "LightRAG context here" }),
      };
    });

    plugin.register(api);
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "find my documents" }],
    });

    assert.ok(result.appendSystemContext.includes("LightRAG context here"));
    assert.ok(errors.some((e) => e.includes("source failed")));
    mock.restoreAll();
  });

  it("continues with pgvector when LightRAG fails", async () => {
    const handlers = {};
    const errors = [];
    const api = {
      pluginConfig: {
        geminiApiKey: "test-key",
        postgresUrl: "postgresql://localhost/knowledge",
        collections: ["col"],
        lightragUrl: "http://lightrag:9621",
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: (msg) => errors.push(msg),
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    mock.method(globalThis, "fetch", async (url) => {
      if (url.includes("generativelanguage")) {
        return {
          ok: true,
          json: async () => ({ embedding: { values: [0.1, 0.2] } }),
        };
      }
      // LightRAG fails
      return { ok: false, status: 503, text: async () => "service down" };
    });

    plugin.register(api);
    // pgvector pool.query will fail (no real DB), but the point is the
    // LightRAG error is logged and doesn't crash the plugin
    const result = await handlers["before_prompt_build"]({
      prompt: "",
      messages: [{ role: "user", content: "find my documents" }],
    });

    assert.ok(errors.some((e) => e.includes("source failed")));
    mock.restoreAll();
  });

  // -----------------------------------------------------------------------
  // Hook: cooldown behavior
  // -----------------------------------------------------------------------

  it("enters cooldown after MAX_CONSECUTIVE_ERRORS", async () => {
    const handlers = {};
    const errors = [];
    const api = {
      pluginConfig: {
        lightragUrl: "http://lightrag:9621",
      },
      logger: {
        warn: () => {},
        info: () => {},
        debug: () => {},
        error: (msg) => errors.push(msg),
      },
      on: (event, handler) => {
        handlers[event] = handler;
      },
    };

    mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });

    plugin.register(api);
    const event = {
      prompt: "",
      messages: [{ role: "user", content: "test query here" }],
    };

    // Trigger 3 consecutive errors (MAX_CONSECUTIVE_ERRORS)
    await handlers["before_prompt_build"](event);
    await handlers["before_prompt_build"](event);
    await handlers["before_prompt_build"](event);

    assert.ok(errors.some((e) => e.includes("cooling down")));

    // 4th call should be silently skipped (cooldown active)
    const errorCountBefore = errors.length;
    await handlers["before_prompt_build"](event);
    assert.equal(errors.length, errorCountBefore);

    mock.restoreAll();
  });
});
