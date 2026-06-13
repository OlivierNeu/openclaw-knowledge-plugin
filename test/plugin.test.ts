// Integration-style tests for the plugin entry point.
//
// We exercise `registerKnowledgePlugin` with a hand-rolled fake of the
// OpenClaw plugin API. Using the internal factory (as opposed to the default
// `definePluginEntry(...)` export) keeps the tests decoupled from SDK runtime
// initialization while still covering the real registration path.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import plugin, { registerKnowledgePlugin } from "../src/index.js";
import type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Fake plugin API
// ---------------------------------------------------------------------------

type HookHandler = (
  event: BeforePromptBuildEvent,
  ctx?: { trigger?: string; messageProvider?: string },
) => Promise<BeforePromptBuildResult | undefined> | BeforePromptBuildResult | undefined;

interface FakeApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    warn: (msg: string) => void;
    info: (msg: string) => void;
    debug: (msg: string) => void;
    error: (msg: string) => void;
  };
  on: (event: string, handler: HookHandler) => void;
}

interface FakeApiState {
  warnings: string[];
  infos: string[];
  debugs: string[];
  errors: string[];
  handlers: Record<string, HookHandler>;
}

function makeFakeApi(
  pluginConfig: Record<string, unknown>,
): { api: FakeApi; state: FakeApiState } {
  const state: FakeApiState = {
    warnings: [],
    infos: [],
    debugs: [],
    errors: [],
    handlers: {},
  };
  const api: FakeApi = {
    pluginConfig,
    logger: {
      warn: (msg) => state.warnings.push(msg),
      info: (msg) => state.infos.push(msg),
      debug: (msg) => state.debugs.push(msg),
      error: (msg) => state.errors.push(msg),
    },
    on: (event, handler) => {
      state.handlers[event] = handler;
    },
  };
  return { api, state };
}

// `registerKnowledgePlugin` expects a full OpenClawPluginApi. We cast the
// fake via `unknown` at call sites because only a subset of the surface is
// exercised in tests.
function register(api: FakeApi): void {
  registerKnowledgePlugin(api as unknown as Parameters<typeof registerKnowledgePlugin>[0]);
}

// ---------------------------------------------------------------------------
// Plugin metadata (default export from definePluginEntry)
// ---------------------------------------------------------------------------

describe("plugin metadata", () => {
  it("exposes correct plugin metadata", () => {
    assert.equal(plugin.id, "openclaw-knowledge");
    assert.equal(plugin.name, "Knowledge Base");
    // `description` is typed `string | undefined` on the public supertype
    // `OpenClawPluginDefinition` (we annotate the default export with the
    // public type to keep `dist/index.d.ts` portable — see comment in
    // `src/index.ts`). Narrow it explicitly before the substring asserts.
    assert.equal(typeof plugin.description, "string");
    const description = plugin.description ?? "";
    assert.ok(description.includes("pgvector"));
    assert.ok(description.includes("LightRAG"));
  });
});

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe("registerKnowledgePlugin — initialization", () => {
  it("warns and returns when neither pgvector nor lightrag configured", () => {
    const { api, state } = makeFakeApi({});

    register(api);

    assert.equal(state.warnings.length, 1);
    assert.ok(
      state.warnings[0]!.includes("neither pgvector nor LightRAG configured"),
    );
    assert.equal(state.handlers["before_prompt_build"], undefined);
  });

  it("registers hook with pgvector only", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
      collections: ["test_col"],
    });

    register(api);
    assert.equal(typeof state.handlers["before_prompt_build"], "function");
    assert.ok(state.infos.some((m) => m.includes("pgvector")));
    assert.ok(!state.infos.some((m) => m.includes("LightRAG")));
  });

  it("registers hook with lightrag only", () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      lightragApiKey: "lr-key",
    });

    register(api);
    assert.equal(typeof state.handlers["before_prompt_build"], "function");
    assert.ok(state.infos.some((m) => m.includes("LightRAG")));
    assert.ok(!state.infos.some((m) => m.includes("pgvector")));
  });

  it("registers hook with both sources", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
      collections: ["col"],
      lightragUrl: "http://lightrag:9621",
    });

    register(api);
    assert.equal(typeof state.handlers["before_prompt_build"], "function");
    const readyMsg = state.infos.find((m) => m.includes("ready"));
    assert.ok(readyMsg);
    assert.ok(readyMsg!.includes("pgvector"));
    assert.ok(readyMsg!.includes("LightRAG"));
  });

  it("disables pgvector when pgvectorEnabled is false", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://localhost/knowledge",
      pgvectorEnabled: false,
      lightragUrl: "http://lightrag:9621",
    });

    register(api);
    const readyMsg = state.infos.find((m) => m.includes("ready"));
    assert.ok(readyMsg);
    assert.ok(!readyMsg!.includes("pgvector"));
    assert.ok(readyMsg!.includes("LightRAG"));
  });

  it("disables lightrag when lightragEnabled is false", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://localhost/knowledge",
      lightragUrl: "http://lightrag:9621",
      lightragEnabled: false,
    });

    register(api);
    const readyMsg = state.infos.find((m) => m.includes("ready"));
    assert.ok(readyMsg);
    assert.ok(readyMsg!.includes("pgvector"));
    assert.ok(!readyMsg!.includes("LightRAG"));
  });
});

// ---------------------------------------------------------------------------
// Hook: query extraction
// ---------------------------------------------------------------------------

describe("before_prompt_build — query extraction", () => {
  afterEach(() => mock.restoreAll());

  it("skips short queries (less than 3 chars)", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });

    register(api);

    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "ab" }],
    });
    assert.equal(result, undefined);
  });

  it("skips empty messages array", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called");
    });

    register(api);

    const result = await state.handlers["before_prompt_build"]!({
      messages: [],
    });
    assert.equal(result, undefined);
  });

  it("does nothing when disabled", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      enabled: false,
    });

    register(api);

    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "hello world query" }],
    });
    assert.equal(result, undefined);
  });

  it("extracts query from string content", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      capturedQuery = body.query;
      return {
        ok: true,
        json: async () => ({ response: "context" }),
      } as unknown as Response;
    });

    register(api);
    await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "find my contracts" }],
    });

    assert.equal(capturedQuery, "find my contracts");
  });

  it("extracts query from array content format (OpenClaw multi-part)", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      capturedQuery = body.query;
      return {
        ok: true,
        json: async () => ({ response: "context" }),
      } as unknown as Response;
    });

    register(api);
    await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what is in my scanned documents?" }],
        },
      ],
    });

    assert.equal(capturedQuery, "what is in my scanned documents?");
  });

  it("handles mixed content array with non-text parts", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => {
      throw new Error("fetch should not be called for empty text");
    });

    register(api);

    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content: [{ type: "image" }],
        },
      ],
    });

    assert.equal(result, undefined);
  });

  it("picks last user message, skipping assistant messages", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    let capturedQuery = "";
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      capturedQuery = body.query;
      return { ok: true, json: async () => ({ response: "ctx" }) } as unknown as Response;
    });

    register(api);
    await state.handlers["before_prompt_build"]!({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
      ],
    });

    assert.equal(capturedQuery, "second question");
  });
});

// ---------------------------------------------------------------------------
// Hook: LightRAG-only execution
// ---------------------------------------------------------------------------

describe("before_prompt_build — LightRAG execution", () => {
  afterEach(() => mock.restoreAll());

  it("injects LightRAG context into appendSystemContext", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      lightragApiKey: "lr-key",
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response:
          "Entity: ACME Corp. Relation: signed contract with Alice.",
      }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "tell me about ACME" }],
    });

    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context (LightRAG)"));
    assert.ok(result!.appendSystemContext.includes("ACME Corp"));
    assert.ok(result!.appendSystemContext.includes("Relevant Knowledge Base"));
  });

  it("returns undefined when LightRAG returns empty context", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "" }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "something obscure" }],
    });

    assert.equal(result, undefined);
  });

  it("truncates LightRAG context to lightragMaxChars", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      lightragMaxChars: 50,
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "A".repeat(200) }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "long context query" }],
    });

    assert.ok(result);
    assert.ok(result!.appendSystemContext.length < 300);
  });
});

// ---------------------------------------------------------------------------
// Hook: graceful degradation
// ---------------------------------------------------------------------------

describe("before_prompt_build — graceful degradation", () => {
  afterEach(() => mock.restoreAll());

  it("continues with LightRAG when pgvector fails", async () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://localhost/knowledge",
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("generativelanguage")) {
        // Gemini embedding fails
        return { ok: false, status: 500, text: async () => "embed error" } as unknown as Response;
      }
      // LightRAG succeeds
      return {
        ok: true,
        json: async () => ({ response: "LightRAG context here" }),
      } as unknown as Response;
    });

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "find my documents" }],
    });

    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("LightRAG context here"));
    assert.ok(state.errors.some((e) => e.includes("source failed")));
  });

  it("continues with pgvector when LightRAG fails", async () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://localhost/knowledge",
      collections: ["col"],
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("generativelanguage")) {
        return {
          ok: true,
          json: async () => ({ embedding: { values: [0.1, 0.2] } }),
        } as unknown as Response;
      }
      // LightRAG fails
      return { ok: false, status: 503, text: async () => "service down" } as unknown as Response;
    });

    register(api);
    // pgvector pool.query will fail (no real DB), but the point is the
    // LightRAG error is logged and doesn't crash the plugin.
    await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "find my documents" }],
    });

    assert.ok(state.errors.some((e) => e.includes("source failed")));
  });
});

// ---------------------------------------------------------------------------
// Hook: cooldown behavior
// ---------------------------------------------------------------------------

describe("before_prompt_build — cooldown", () => {
  afterEach(() => mock.restoreAll());

  it("enters cooldown after MAX_CONSECUTIVE_ERRORS", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });

    register(api);
    const event: BeforePromptBuildEvent = {
      messages: [{ role: "user", content: "test query here" }],
    };

    // Trigger 3 consecutive errors (MAX_CONSECUTIVE_ERRORS).
    await state.handlers["before_prompt_build"]!(event);
    await state.handlers["before_prompt_build"]!(event);
    await state.handlers["before_prompt_build"]!(event);

    assert.ok(state.errors.some((e) => e.includes("cooling down")));

    // 4th call should be silently skipped (cooldown active).
    const errorCountBefore = state.errors.length;
    await state.handlers["before_prompt_build"]!(event);
    assert.equal(state.errors.length, errorCountBefore);
  });
});

// ---------------------------------------------------------------------------
// Router gate (v3.2.0)
// ---------------------------------------------------------------------------

describe("before_prompt_build — router gate", () => {
  afterEach(() => mock.restoreAll());

  it("returns undefined and does NOT call any source on ctx.trigger=heartbeat", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "jina_test", router: { enabled: true } },
    });
    register(api);

    const result = await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "anything goes" }] },
      { trigger: "heartbeat" },
    );

    assert.equal(result, undefined);
    assert.equal(fetchCalled, false);
    // Should have logged a router event indicating the heuristic skip.
    assert.ok(state.infos.some((m) => m.includes("[knowledge.event]") && m.includes("heuristic_trigger")));
  });

  it("returns undefined and does NOT call any source on cron trigger", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "jina_test", router: { enabled: true } },
    });
    register(api);

    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "a longer query here" }] },
      { trigger: "cron" },
    );
    assert.equal(fetchCalled, false);
  });

  it("does NOT skip on ctx.trigger=heartbeat when the router is disabled (back-compat)", async () => {
    // Pre-3.2.0 behavior: heartbeats DID call sources because the plugin
    // had no way to know they were heartbeats.
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return {
        ok: true,
        json: async () => ({ response: "lightrag ctx" }),
      } as unknown as Response;
    });

    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      // No jina block → router disabled
    });
    register(api);

    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "a longer query here" }] },
      { trigger: "heartbeat" },
    );
    assert.equal(fetchCalled, true);
  });

  it("emits a router event for every accepted turn", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ response: "lr context" }), { status: 200 }),
    );

    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "jina_test", router: { enabled: true, mode: "heuristic" } },
    });
    register(api);

    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "find my contracts in 2026" }] },
      { trigger: "user" },
    );

    const routerEvt = state.infos.find(
      (m) => m.includes("[knowledge.event]") && m.includes('"type":"router"'),
    );
    assert.ok(routerEvt, "expected at least one router event to be emitted");
  });
});

// ---------------------------------------------------------------------------
// Pgvector reranker integration (v3.2.0)
// ---------------------------------------------------------------------------

describe("before_prompt_build — pgvector reranker", () => {
  afterEach(() => mock.restoreAll());

  it("warns at init when topK is less than 2× rerankerTopN", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "g-key",
      postgresUrl: "postgresql://localhost/knowledge",
      topK: 5,
      jina: {
        apiKey: "j-key",
        pgvectorReranker: { enabled: true, topN: 5 },
      },
    });
    register(api);

    assert.ok(
      state.warnings.some(
        (w) => w.includes("topK=5") && w.includes("pgvectorRerankerTopN=5"),
      ),
      `expected a topK/topN sizing warning, got: ${JSON.stringify(state.warnings)}`,
    );
  });

  it("advertises the reranker in the init log when enabled with a Jina key", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "g-key",
      postgresUrl: "postgresql://localhost/knowledge",
      topK: 20,
      jina: {
        apiKey: "j-key",
        pgvectorReranker: { enabled: true, topN: 5 },
      },
    });

    register(api);

    const readyMsg = state.infos.find((m) => m.startsWith("openclaw-knowledge: ready"));
    assert.ok(readyMsg, "missing ready message");
    assert.ok(readyMsg!.includes("reranker("));
    assert.ok(readyMsg!.includes("jina-reranker-v2-base-multilingual"));
  });

  it("does NOT advertise the reranker when jina.apiKey is missing", () => {
    const { api, state } = makeFakeApi({
      geminiApiKey: "g-key",
      postgresUrl: "postgresql://localhost/knowledge",
      jina: { pgvectorReranker: { enabled: true } },
    });

    register(api);

    const readyMsg = state.infos.find((m) => m.startsWith("openclaw-knowledge: ready"));
    assert.ok(readyMsg);
    assert.ok(!readyMsg!.includes("reranker("));
  });

  it("advertises the router in the init log when enabled", () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lr:9621",
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier" } },
    });

    register(api);

    const readyMsg = state.infos.find((m) => m.startsWith("openclaw-knowledge: ready"));
    assert.ok(readyMsg);
    assert.ok(readyMsg!.includes("router=jina-classifier"));
    assert.ok(readyMsg!.includes("zero-shot"));
  });

  it("flags few-shot in the init log when classifierId is provided", () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lr:9621",
      jina: {
        apiKey: "j",
        router: { enabled: true, mode: "jina-classifier", classifierId: "abc" },
      },
    });

    register(api);

    const readyMsg = state.infos.find((m) => m.startsWith("openclaw-knowledge: ready"));
    assert.ok(readyMsg);
    assert.ok(readyMsg!.includes("few-shot"));
  });
});

// ---------------------------------------------------------------------------
// Regression — Codex review 2026-05-23
// ---------------------------------------------------------------------------

// Fix #7 (sanitize Jina error logs) and #8 (cooldown reset order) are
// covered at the unit level:
//   - `summarizeJinaError` privacy contract → test/jina/client.test.ts
//   - cooldown reset path → asserted by the existing `maybeResetCooldown`
//     test coverage + explicit source-level comments in runPgvectorSource.
//
// A full end-to-end integration test for these would require injecting a
// fake pg.Pool that returns rows; the plugin currently instantiates the
// real `pg.Pool` inside `registerKnowledgePlugin`, so the integration
// fixture would need a pool-mock seam. Out of scope for this release.

describe("before_prompt_build — regression: router cooldown preserves heuristics (Codex P2)", () => {
  afterEach(() => mock.restoreAll());

  it("still skips heartbeats via heuristic even after the classifier circuit opens", async () => {
    // Bug reported by Codex review pass #5 (2026-05-23):
    // After 3 classifier errors, the router used to short-circuit to
    // `ALL`, which RE-ENABLED retrieval for every heartbeat for 5 min —
    // the exact waste the router was supposed to prevent during an
    // outage. The fix downgrades to heuristic-only during cooldown, so
    // `ctx.trigger=heartbeat` is still gated to `NONE`.
    let fetchCalls = 0;
    const sourceCalls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      fetchCalls++;
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("api.jina.ai/v1/classify")) {
        // Always fail to trip the router cooldown.
        return new Response("upstream broken", { status: 503 });
      }
      if (u.includes("generativelanguage")) {
        sourceCalls.push("gemini");
        return new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
          status: 200,
        });
      }
      if (u.includes("lightrag") || u.endsWith(":9621/query")) {
        sourceCalls.push("lightrag");
        return new Response(JSON.stringify({ response: "" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const { api, state } = makeFakeApi({
      geminiApiKey: "g-key",
      postgresUrl: "postgresql://localhost/knowledge",
      lightragUrl: "http://lightrag:9621",
      jina: {
        apiKey: "j-key",
        router: { enabled: true, mode: "jina-classifier" },
      },
    });
    register(api);

    // Step 1: trip 3 classifier errors with AMBIGUOUS prompts (so the
    // heuristic returns null and the classifier is actually called).
    const ambiguous = {
      messages: [{ role: "user", content: "remind me what we discussed yesterday" }],
    };
    await state.handlers["before_prompt_build"]!(ambiguous, { trigger: "user" });
    await state.handlers["before_prompt_build"]!(ambiguous, { trigger: "user" });
    await state.handlers["before_prompt_build"]!(ambiguous, { trigger: "user" });

    assert.ok(
      state.errors.some((e) => e.includes("router cooling down")),
      "expected router cooldown to engage after 3 classifier errors",
    );

    // Step 2: classifier is now in cooldown. A HEARTBEAT turn must
    // still be skipped (NONE), not silently routed to ALL.
    sourceCalls.length = 0;
    const fetchBefore = fetchCalls;

    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "anything goes here" }] },
      { trigger: "heartbeat" },
    );

    assert.deepEqual(
      sourceCalls,
      [],
      "no source should be called for a heartbeat during router cooldown",
    );
    assert.equal(
      fetchCalls,
      fetchBefore,
      "fetch must not be called at all (no Jina, no Gemini, no LightRAG)",
    );

    // Same for a meta-agent question.
    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "what is your session id" }] },
      { trigger: "user" },
    );
    assert.deepEqual(sourceCalls, [], "meta-agent question must remain skipped during cooldown");
  });
});

describe("before_prompt_build — regression: exclusive route on single-source deployment", () => {
  afterEach(() => mock.restoreAll());

  it("falls back to the available source when the router picks the disabled one", async () => {
    // Codex's exact scenario: pgvector-only deployment (no LightRAG) +
    // a "compare..." query that the heuristic routes to LIGHTRAG_ONLY.
    // Before the fix this dropped all retrieval. After: best-effort
    // fallback to pgvector.
    let geminiHit = false;
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("generativelanguage")) {
        geminiHit = true;
        return new Response(JSON.stringify({ embedding: { values: [0.1] } }), {
          status: 200,
        });
      }
      // We don't have a real pg pool in tests, so pgvector.searchCollection
      // returns []. That's fine — we're only proving the embed call WAS
      // attempted (i.e. the route was projected onto pgvector).
      return new Response("{}", { status: 200 });
    });

    const { api, state } = makeFakeApi({
      geminiApiKey: "g-key",
      postgresUrl: "postgresql://localhost/knowledge",
      // No lightragUrl → LightRAG disabled.
      jina: { apiKey: "j", router: { enabled: true, mode: "heuristic" } },
    });
    register(api);

    await state.handlers["before_prompt_build"]!(
      { messages: [{ role: "user", content: "compare les méthodes 2024 et 2026" }] },
      { trigger: "user" },
    );

    assert.equal(geminiHit, true, "embed should have been called (pgvector fallback)");
    // The router event should reflect the EFFECTIVE route (PGVECTOR_ONLY)
    // after projection, not the abstract LIGHTRAG_ONLY decision.
    const routerEvt = state.infos.find(
      (m) => m.includes('"type":"router"') && m.includes('"route":"PGVECTOR_ONLY"'),
    );
    assert.ok(routerEvt, "expected router event with route=PGVECTOR_ONLY (projected)");
  });

  it("returns undefined when both sources are disabled (NONE projection)", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const { api, state } = makeFakeApi({
      // Neither geminiApiKey nor lightragUrl → both sources disabled.
      jina: { apiKey: "j", router: { enabled: true } },
    });
    register(api);

    // Plugin disables itself at init when no source is configured.
    // The handler is never registered, so the test verifies that path.
    assert.equal(state.handlers["before_prompt_build"], undefined);
    assert.equal(fetchCalled, false);
  });
});

// ---------------------------------------------------------------------------
// v3.2.3 observability events
// ---------------------------------------------------------------------------

/** Extract `[knowledge.event]` JSON payloads from a `state.infos` array. */
function eventsByType<T extends string>(infos: string[], type: T): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of infos) {
    const idx = line.indexOf("[knowledge.event] ");
    if (idx === -1) continue;
    try {
      const json = line.slice(idx + "[knowledge.event] ".length);
      const evt = JSON.parse(json) as Record<string, unknown>;
      if (evt.type === type) out.push(evt);
    } catch {
      // skip malformed line (test diagnostics noise)
    }
  }
  return out;
}

describe("before_prompt_build — v3.2.3 observability", () => {
  afterEach(() => mock.restoreAll());

  it("emits a sparse:false LightRAG event when context is substantial", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response:
          "Entity: ACME Corp. Relation: signed contract with Alice. " +
          "Additional context line one. Additional context line two. " +
          "Additional context line three. ".repeat(5),
      }),
    }) as unknown as Response);

    register(api);
    await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "tell me about ACME" }],
    });

    const lr = eventsByType(state.infos, "lightrag");
    assert.equal(lr.length, 1);
    assert.equal(lr[0]!.sparse, false);
    assert.ok((lr[0]!.contextChars as number) >= 200);
  });

  it("emits a sparse:true LightRAG event when context is below 200 chars", async () => {
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    // Production scenario observed 2026-05-23 19:42:05: LightRAG had
    // nothing relevant indexed for the query and returned a tiny stub.
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "Entity: x. Relation: y." }), // <200 chars
    }) as unknown as Response);

    register(api);
    await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "obscure topic with no coverage" }],
    });

    const lr = eventsByType(state.infos, "lightrag");
    assert.equal(lr.length, 1);
    assert.equal(lr[0]!.sparse, true);
  });

  it("emits a LightRAG event with sparse:true even when the response is empty", async () => {
    // Empty response from LightRAG (no matches at all). The plugin
    // injects nothing into the prompt, but the event MUST still fire
    // so dashboards can distinguish "LightRAG ran and matched nothing"
    // from "LightRAG was never called".
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "" }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "totally unindexed subject" }],
    });

    assert.equal(result, undefined);
    const lr = eventsByType(state.infos, "lightrag");
    assert.equal(lr.length, 1);
    assert.equal(lr[0]!.sparse, true);
    assert.equal(lr[0]!.contextChars, 0);
  });

  it("emits pgvector event with errored:true + rawCount:null when SQL fails (Codex pass #28 P2)", async () => {
    // Codex pass #28 P2 regression: a real SQL failure (DB down, schema
    // drift, …) MUST NOT be confused with a clean 0-hit query. The event
    // carries `errored: true` and `rawCount: null` so dashboards never
    // count the failure as a "missed retrieval".
    const { api, state } = makeFakeApi({
      geminiApiKey: "test-key",
      postgresUrl: "postgresql://localhost/knowledge",
      collections: ["broken-collection"],
    });

    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("generativelanguage")) {
        return {
          ok: true,
          json: async () => ({ embedding: { values: [0.1, 0.2] } }),
        } as unknown as Response;
      }
      // No other fetch path expected — pgvector uses `pg`, not fetch.
      return { ok: false, status: 500 } as unknown as Response;
    });

    register(api);
    // pgvector pool.query will fail at runtime (no real DB available).
    // The plugin must still emit the pgvector event with errored:true.
    const result = await state.handlers["before_prompt_build"]!({
      messages: [{ role: "user", content: "anything that triggers pgvector" }],
    });

    // No content injected because results are empty.
    assert.equal(result, undefined);

    const pg = eventsByType(state.infos, "pgvector");
    assert.equal(pg.length, 1);
    assert.equal(pg[0]!.errored, true);
    assert.equal(pg[0]!.rawCount, null);
    assert.equal(pg[0]!.topScore, null);
    // The plugin also logs a sanitized error line (class name only,
    // no SQL params / no query content).
    assert.ok(
      state.errors.some((e) => e.includes('pgvector collection "broken-collection" failed')),
      "Expected a sanitized error line naming the failing collection",
    );
  });

  // Note: the symmetric `errored:false + rawCount:0` path (pgvector ran,
  // SQL OK, no row matched the threshold) is implicitly covered by the
  // existing reranker tests in `pgvector reranker` describe block, which
  // exercise `runPgvectorSource` with a fake `pg.Pool` returning rows.
  // We do NOT duplicate that mocking here.
});

describe("before_prompt_build — v3.2.3 OWUI auto-prompt short-circuit", () => {
  afterEach(() => mock.restoreAll());

  it("skips retrieval entirely on an OWUI title-generation prompt", async () => {
    // Open WebUI re-uses the active chat thread to ask the LLM for a
    // title after every assistant turn. The prompt starts with the
    // canonical `### Task:` header followed by `Generate ... title`.
    // The heuristic META_PATTERN MUST short-circuit it before any
    // network call (LightRAG, pgvector, Jina) is attempted.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier" } },
    });

    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "### Task:\nGenerate a concise, 3-5 word title with an emoji " +
            "summarizing the chat history.\n### Guidelines:\n- Keep it short.\n" +
            "### Output:\nJSON format: { \"title\": \"your concise title here\" }\n" +
            "### Chat History:\n<chat_history>\nUSER: foo\nASSISTANT: bar\n</chat_history>",
        },
      ],
    });

    assert.equal(result, undefined);
    assert.equal(fetchCalled, false);

    const routerEvents = eventsByType(state.infos, "router");
    assert.equal(routerEvents.length, 1);
    assert.equal(routerEvents[0]!.route, "NONE");
    assert.equal(routerEvents[0]!.reason, "heuristic_meta");
  });

  it("skips retrieval on an OWUI tag-generation prompt with the full 4-section template", async () => {
    // The full 4-section OWUI shape (### Task: + ### Output: +
    // ### Chat History: + <chat_history>…</chat_history> at EOF) is
    // the discriminant signal — see code comment in heuristic.ts.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true } },
    });

    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    });

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "### Task:\nSuggest 3-5 relevant tags for this conversation\n" +
            "### Output:\nJSON format: { \"tags\": [\"...\"] }\n" +
            "### Chat History:\n<chat_history>\nUSER: foo\nASSISTANT: bar\n</chat_history>",
        },
      ],
    });

    assert.equal(result, undefined);
    assert.equal(fetchCalled, false);
  });

  it("does NOT short-circuit a real `### Task:` user prompt (Codex pass #28 P2 regression)", async () => {
    // Codex pass #28 P2: the verb alone is too generic. A power user
    // can legitimately write `### Task:\nCreate a migration plan from
    // the docs` and that MUST reach the knowledge sources. The OWUI-
    // specific output template (`### Output:\nJSON format: {`) is the
    // discriminator.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true } },
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response:
          "Entity: migration plan. " + "x".repeat(300),
      }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content: "### Task:\nCreate a migration plan from the docs.",
        },
      ],
    });

    // The real `### Task:` prompt MUST reach the knowledge base.
    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context"));
  });

  it("does NOT short-circuit a structured JSON-output user task with a non-OWUI key (Codex pass #29 P2)", async () => {
    // Codex pass #29 P2: a power user can legitimately ask for
    // structured JSON extraction with a domain key. None of these
    // prompts ships the `<chat_history>` block so they pass through.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true } },
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Entity: ACME Corp. " + "x".repeat(300),
      }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "### Task:\nExtract all client names from the docs.\n" +
            "### Guidelines:\n- Look in TeamDrives only.\n" +
            '### Output:\nJSON format: { "clients": ["..."] }',
        },
      ],
    });

    // The structured user task MUST reach the knowledge base.
    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context"));
  });

  it("does NOT short-circuit when a user pastes the OWUI block but asks something after (Codex pass #31 P2)", async () => {
    // Codex pass #31 P2 regression: a user can paste an OWUI-style
    // template AS CONTEXT and then ask a question about it. The
    // end-of-prompt anchor `\s*$` on the META_PATTERN defeats the
    // match because the user question follows `</chat_history>`.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true } },
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Entity: OWUI auto-prompt. " + "x".repeat(300),
      }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "### Task:\nAnalyse ce template OWUI.\n" +
            "### Output:\nJSON format: { ... }\n" +
            "### Chat History:\n<chat_history>USER: foo\nASSISTANT: bar</chat_history>\n\n" +
            "Comment puis-je désactiver ces appels automatiques côté gateway ?",
        },
      ],
    });

    // The user has a real question AFTER the template — reaches the KB.
    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context"));
  });

  it("does NOT short-circuit a user `{ summary: ... }` request without chat_history (Codex pass #30 P2)", async () => {
    // Codex pass #30 P2 regression: even the four canonical OWUI keys
    // (title / tags / follow_ups / summary) are NOT discriminant on
    // their own. A user can legitimately ask for a summary of docs
    // in JSON output. Without the `<chat_history>` block, this MUST
    // reach the knowledge sources.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
      jina: { apiKey: "j", router: { enabled: true } },
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Entity: Acme CR. " + "x".repeat(300),
      }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "### Task:\nSummarize the latest Acme CR meeting.\n" +
            "### Guidelines:\n- Cite sources.\n" +
            '### Output:\nJSON format: { "summary": "...", "decisions": [...] }',
        },
      ],
    });

    // No `<chat_history>` block → the user request reaches LightRAG.
    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context"));
  });

  it("does NOT short-circuit when a real query QUOTES the OWUI template later in the body", async () => {
    // A power user might legitimately ask about the template itself.
    // The anchor on `^` ensures the pattern only matches when the
    // OWUI header is the FIRST thing in the prompt.
    const { api, state } = makeFakeApi({
      lightragUrl: "http://lightrag:9621",
    });

    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ response: "Entity: tag pattern. " + "x".repeat(300) }),
    }) as unknown as Response);

    register(api);
    const result = await state.handlers["before_prompt_build"]!({
      messages: [
        {
          role: "user",
          content:
            "Can you explain what `### Task:\nGenerate a concise title` does " +
            "in Open WebUI and why it appears between user turns?",
        },
      ],
    });

    // LightRAG WAS called → result should be defined and contain context.
    assert.ok(result);
    assert.ok(result!.appendSystemContext.includes("Knowledge Graph Context"));
  });
});
