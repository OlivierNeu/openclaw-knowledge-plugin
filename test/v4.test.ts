// Integration tests for the 4.0 hook behavior and control plane, driven
// through `registerKnowledgePlugin` with a fake host API that mimics the
// upstream 2026.9 surfaces (session extension, session actions, Gateway
// methods, commands, tools, runtime session store, hook options).

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  registerKnowledgePlugin,
  resetSharedStateForTests,
  sanitizeSourceError,
} from "../src/index.js";
import { DEFAULT_ROUTER_LABELS } from "../src/router/labels.js";
import type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  PluginHookAgentContext,
} from "../src/types.js";

type Handler = (
  event: BeforePromptBuildEvent,
  ctx?: PluginHookAgentContext,
) => Promise<BeforePromptBuildResult | undefined>;

interface Captured {
  infos: string[];
  warnings: string[];
  errors: string[];
  handler?: Handler;
  hookOpts?: { timeoutMs?: number };
  sessionExtension?: {
    namespace: string;
    project?: (ctx: { state?: unknown; sessionKey: string }) => unknown;
    cleanup?: (ctx: { reason: string; sessionKey?: string }) => void;
  };
  sessionActions: Record<string, { requiredScopes?: string[]; schema?: unknown; handler: (ctx: unknown) => unknown }>;
  gatewayMethods: Record<string, { handler: (opts: unknown) => unknown; opts?: { scope?: string } }>;
  commands: Record<string, { handler: (ctx: unknown) => Promise<{ text: string; continueAgent?: boolean }> }>;
  toolFactory?: (ctx: { agentId?: string; sessionKey?: string }) => {
    name: string;
    parameters: unknown;
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{
      content: Array<{ type: string; text: string }>;
      details: Record<string, unknown>;
    }>;
  };
  toolOpts?: { name?: string; optional?: boolean };
  store: Map<string, Record<string, Record<string, unknown>>>;
  emitted: Array<{ runId: string; stream: string; data: unknown }>;
}

function makeHost(pluginConfig: Record<string, unknown>): { api: unknown; cap: Captured } {
  const cap: Captured = {
    infos: [],
    warnings: [],
    errors: [],
    sessionActions: {},
    gatewayMethods: {},
    commands: {},
    store: new Map(),
    emitted: [],
  };
  const api = {
    id: "openclaw-knowledge",
    pluginConfig,
    logger: {
      info: (m: string) => cap.infos.push(m),
      warn: (m: string) => cap.warnings.push(m),
      error: (m: string) => cap.errors.push(m),
      debug: () => undefined,
    },
    on: (_name: string, handler: Handler, opts?: { timeoutMs?: number }) => {
      cap.handler = handler;
      cap.hookOpts = opts;
    },
    emitAgentEvent: (e: { runId: string; stream: string; data: unknown }) => {
      cap.emitted.push(e);
      return { emitted: true };
    },
    registerTool: (factory: Captured["toolFactory"], opts: Captured["toolOpts"]) => {
      cap.toolFactory = factory;
      cap.toolOpts = opts;
    },
    registerCommand: (def: { name: string; handler: Captured["commands"][string]["handler"] }) => {
      cap.commands[def.name] = { handler: def.handler };
    },
    registerGatewayMethod: (name: string, handler: (o: unknown) => unknown, opts?: { scope?: string }) => {
      cap.gatewayMethods[name] = { handler, opts };
    },
    session: {
      state: {
        registerSessionExtension: (ext: Captured["sessionExtension"]) => {
          cap.sessionExtension = ext;
        },
      },
      controls: {
        registerSessionAction: (action: { id: string } & Captured["sessionActions"][string]) => {
          cap.sessionActions[action.id] = action;
        },
      },
    },
    runtime: {
      agent: {
        session: {
          getSessionEntry: ({ sessionKey }: { sessionKey: string }) => {
            const ext = cap.store.get(sessionKey);
            return ext ? { pluginExtensions: structuredClone(ext) } : {};
          },
          patchSessionEntry: async ({
            sessionKey,
            update,
          }: {
            sessionKey: string;
            update: (e: { pluginExtensions?: Record<string, Record<string, unknown>> }) => {
              pluginExtensions?: Record<string, Record<string, unknown>>;
            } | null;
          }) => {
            const current = { pluginExtensions: structuredClone(cap.store.get(sessionKey) ?? {}) };
            const patch = update(current);
            // Host semantics: a null patch leaves the row untouched.
            if (!patch) return current;
            cap.store.set(sessionKey, patch.pluginExtensions ?? {});
            return { ...current, ...patch };
          },
        },
      },
    },
  };
  return { api, cap };
}

function register(api: unknown): void {
  registerKnowledgePlugin(api as Parameters<typeof registerKnowledgePlugin>[0]);
}

function events(infos: string[]): Array<Record<string, unknown>> {
  return infos
    .filter((m) => m.startsWith("[knowledge.event] {"))
    .map((m) => JSON.parse(m.slice("[knowledge.event] ".length)) as Record<string, unknown>);
}

function lightragResponse(text: string): Response {
  return new Response(JSON.stringify({ response: text, references: [{ file_path: "gdrive/abc" }] }), {
    status: 200,
  });
}

/** Wait for a fetch abort (the mock never answers on its own). */
function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  mock.restoreAll();
  resetSharedStateForTests();
});

describe("4.0 — registration", () => {
  it("registers the hook with an explicit timeoutMs above the retrieval budget", () => {
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", retrievalBudgetMs: 4000 });
    register(api);
    assert.equal(typeof cap.handler, "function");
    assert.equal(cap.hookOpts?.timeoutMs, 5500);
  });

  it("registers the optional knowledge_search tool and the control plane", () => {
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    assert.deepEqual(cap.toolOpts, { name: "knowledge_search", optional: true });
    assert.equal(cap.sessionExtension?.namespace, "policy");
    assert.deepEqual(Object.keys(cap.sessionActions).sort(), ["policy.get", "policy.reset", "policy.set"]);
    assert.equal(cap.sessionActions["policy.get"]!.requiredScopes?.[0], "operator.read");
    assert.equal(cap.sessionActions["policy.set"]!.requiredScopes?.[0], "operator.write");
    assert.deepEqual(Object.keys(cap.gatewayMethods).sort(), ["knowledge.policy.get", "knowledge.sources"]);
    for (const m of Object.values(cap.gatewayMethods)) assert.equal(m.opts?.scope, "operator.read");
    assert.ok(cap.commands.knowledge);
  });

  it("survives a host without any 4.0 surface (legacy api)", () => {
    const infos: string[] = [];
    let handler: unknown;
    register({
      pluginConfig: { lightragUrl: "http://lr:9621" },
      logger: { info: (m: string) => infos.push(m), warn: () => undefined, error: () => undefined },
      on: (_n: string, h: unknown) => (handler = h),
    });
    assert.equal(typeof handler, "function");
  });
});

describe("4.0 — injection target", () => {
  it("injects on the user message (prependContext) by default", async () => {
    mock.method(globalThis, "fetch", async () => lightragResponse("Graph facts about ACME Corp."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", provenanceReport: "metadata" });
    register(api);
    const result = await cap.handler!({ prompt: "who works on the ACME project?" }, { runId: "r1", sessionKey: "agent:olivier:main" });
    assert.ok(result?.prependContext?.includes("ACME Corp"));
    assert.ok(result?.prependContext?.startsWith("<relevant-documents"));
    assert.equal(result?.appendSystemContext, undefined);
    const report = cap.emitted[0]?.data as { injected?: { position?: string } };
    assert.equal(report?.injected?.position, "user_prepend");
  });

  it("supports appendContext", async () => {
    mock.method(globalThis, "fetch", async () => lightragResponse("Graph facts."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", injectionTarget: "appendContext" });
    register(api);
    const result = await cap.handler!({ prompt: "tell me about the roadmap" });
    assert.ok(result?.appendContext?.includes("Graph facts."));
    assert.equal(result?.prependContext, undefined);
  });
});

describe("4.0 — skip stage", () => {
  it("skips sub-agent sessions and manual runs before any fetch, with router events", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("x"));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    assert.equal(
      await cap.handler!({ prompt: "summarize the contract" }, { sessionKey: "agent:olivier:subagent:1" }),
      undefined,
    );
    assert.equal(await cap.handler!({ prompt: "summarize the contract" }, { trigger: "manual" }), undefined);
    assert.equal(
      await cap.handler!(
        { prompt: "summarize the contract" },
        { trigger: "user", inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" } },
      ),
      undefined,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
    const reasons = events(cap.infos)
      .filter((e) => e.type === "router")
      .map((e) => e.reason);
    assert.deepEqual(reasons, ["skip_subagent_session", "heuristic_trigger", "skip_non_human_input"]);
    const timings = events(cap.infos).filter((e) => e.type === "timing");
    assert.equal(timings.length, 3);
    assert.equal(timings[0]!.skipped, "skip_subagent_session");
  });

  it("skips acknowledgements on every channel (router disabled too)", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("x"));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    assert.equal(await cap.handler!({ prompt: "merci beaucoup !" }, { messageProvider: "telegram" }), undefined);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("4.0 — budgets", () => {
  it("aborts a slow LightRAG call at lightragTimeoutMs", async () => {
    mock.method(globalThis, "fetch", async (_u: unknown, init?: RequestInit) => hangUntilAborted(init));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", lightragTimeoutMs: 60, retrievalBudgetMs: 2000 });
    register(api);
    const started = Date.now();
    const result = await cap.handler!({ prompt: "what did we decide about pricing" });
    assert.equal(result, undefined);
    assert.ok(Date.now() - started < 1000);
    assert.ok(cap.errors.some((e) => e.includes("timed out")));
  });

  it("pure timeouts do not trip the global cooldown", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async (_u: unknown, init?: RequestInit) => {
      calls++;
      return hangUntilAborted(init);
    });
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", lightragTimeoutMs: 20 });
    register(api);
    for (let i = 0; i < 4; i++) await cap.handler!({ prompt: `what did we decide about pricing ${i}` });
    assert.equal(calls, 4, "the 4th turn must still reach LightRAG");
    assert.equal(cap.errors.some((e) => e.includes("cooling down")), false);
  });

  it("returns partial results when the global budget elapses", async () => {
    mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("http://fast")) return lightragResponse("FAST graph context.");
      return hangUntilAborted(init);
    });
    const { api, cap } = makeHost({
      sources: {
        fast: { type: "lightrag", url: "http://fast:9621" },
        slow: { type: "lightrag", url: "http://slow:9621" },
      },
      lightragTimeoutMs: 5000,
      retrievalBudgetMs: 150,
    });
    register(api);
    const started = Date.now();
    const result = await cap.handler!({ prompt: "what did we decide about pricing" });
    assert.ok(Date.now() - started < 1500);
    assert.ok(result?.prependContext?.includes("FAST graph context."));
    assert.ok(result?.prependContext?.includes("LightRAG: fast"));
    const timing = events(cap.infos).find((e) => e.type === "timing")!;
    assert.equal(timing.budgetExceeded, true);
    assert.equal(timing.injected, true);
    assert.ok(cap.warnings.some((w) => w.includes("partial results")));
  });

  it("does not inject when the host already stopped awaiting the handler", async () => {
    mock.method(globalThis, "fetch", async () => lightragResponse("Late context."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", provenanceReport: "metadata" });
    register(api);
    const result = await cap.handler!(
      { prompt: "tell me about the roadmap" },
      { runId: "r", hookInvocation: { assertActive: () => { throw new Error("inactive"); } } },
    );
    assert.equal(result, undefined);
    assert.equal(cap.emitted.length, 0);
  });
});

describe("4.0 — LightRAG query modes and keywords", () => {
  function captureBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, "fetch", async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return lightragResponse("ctx ctx ctx");
    });
    return bodies;
  }

  it("uses naive for a PGVECTOR_ONLY lookup projected onto LightRAG, hybrid for graph questions", async () => {
    const bodies = captureBodies();
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      jina: { router: { enabled: true, mode: "heuristic" } },
    });
    register(api);
    await cap.handler!({ prompt: "which version of the release notes is current?" });
    await cap.handler!({ prompt: "compare les offres de coaching" });
    await cap.handler!({ prompt: "tell me something about the roadmap" });
    assert.deepEqual(bodies.map((b) => b.mode), ["naive", "hybrid", "hybrid"]);
  });

  it("legacy lightragQueryMode overrides every route; byRoute overrides it", async () => {
    const bodies = captureBodies();
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      lightragQueryMode: "local",
      lightragQueryModeByRoute: { fallback: "naive" },
      jina: { router: { enabled: true, mode: "heuristic" } },
    });
    register(api);
    await cap.handler!({ prompt: "which version of the release notes is current?" });
    await cap.handler!({ prompt: "tell me something about the roadmap" });
    assert.deepEqual(bodies.map((b) => b.mode), ["local", "naive"]);
  });

  it("sends hl/ll keywords when lightragLocalKeywords=true (not for naive)", async () => {
    const bodies = captureBodies();
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      lightragLocalKeywords: true,
      jina: { router: { enabled: true, mode: "heuristic" } },
    });
    register(api);
    await cap.handler!({ prompt: "Quel est le statut du Projet Hélios chez ACME ?" });
    assert.ok(Array.isArray(bodies[0]!.ll_keywords));
    assert.ok((bodies[0]!.ll_keywords as string[]).includes("Projet Hélios"));
    await cap.handler!({ prompt: "which version of the release notes is current?" });
    assert.equal(bodies[1]!.mode, "naive");
    assert.equal("hl_keywords" in bodies[1]!, false);
  });
});

describe("4.0 — jina-classifier-parallel", () => {
  function classifierFetch(label: string, score: number, calls: string[]) {
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.jina.ai/v1/classify")) {
        calls.push("classify");
        await new Promise((r) => setTimeout(r, 30));
        return new Response(JSON.stringify({ data: [{ prediction: label, score }] }), { status: 200 });
      }
      calls.push("lightrag");
      return lightragResponse("Speculative graph context.");
    });
  }

  it("launches sources during classification and keeps them on a positive route", async () => {
    const calls: string[] = [];
    classifierFetch(DEFAULT_ROUTER_LABELS.find((l) => l.startsWith("LIGHTRAG_ONLY"))!, 0.6, calls);
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier-parallel" } },
    });
    register(api);
    const result = await cap.handler!({ prompt: "remind me what we discussed yesterday" });
    assert.deepEqual(calls.slice(0, 2).sort(), ["classify", "lightrag"]);
    assert.ok(result?.prependContext?.includes("Speculative graph context."));
  });

  it("re-plans a speculative LightRAG call when the confident route needs another mode", async () => {
    const modes: string[] = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.jina.ai/v1/classify")) {
        await new Promise((r) => setTimeout(r, 20));
        const label = DEFAULT_ROUTER_LABELS.find((l) => l.startsWith("LIGHTRAG_ONLY"))!;
        return new Response(JSON.stringify({ data: [{ prediction: label, score: 0.7 }] }), { status: 200 });
      }
      modes.push((JSON.parse(String(init?.body)) as { mode: string }).mode);
      return lightragResponse("Graph context.");
    });
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      lightragQueryModeByRoute: { fallback: "naive" },
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier-parallel" } },
    });
    register(api);
    const result = await cap.handler!({ prompt: "remind me what we discussed yesterday" });
    assert.deepEqual(modes, ["naive", "hybrid"]);
    assert.ok(result?.prependContext?.includes("Graph context."));
    const timing = events(cap.infos).find((e) => e.type === "timing")!;
    assert.equal(timing.speculativeDiscarded, 1);
  });

  it("does not speculate for a hybrid policy (it only injects on a confident hit)", async () => {
    const calls: string[] = [];
    classifierFetch(DEFAULT_ROUTER_LABELS.find((l) => l.startsWith("NONE"))!, 0.8, calls);
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      defaults: { injection: "hybrid" },
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier-parallel" } },
    });
    register(api);
    assert.equal(await cap.handler!({ prompt: "remind me what we discussed yesterday" }), undefined);
    assert.deepEqual(calls, ["classify"]);
  });

  it("discards speculative work when the classifier says NONE", async () => {
    const calls: string[] = [];
    classifierFetch(DEFAULT_ROUTER_LABELS.find((l) => l.startsWith("NONE"))!, 0.8, calls);
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      jina: { apiKey: "j", router: { enabled: true, mode: "jina-classifier-parallel" } },
    });
    register(api);
    const result = await cap.handler!({ prompt: "remind me what we discussed yesterday" });
    assert.equal(result, undefined);
    assert.ok(calls.includes("lightrag"));
    const timing = events(cap.infos).find((e) => e.type === "timing")!;
    assert.equal(timing.speculativeDiscarded, 1);
  });
});

describe("4.0 — per-session cache", () => {
  it("serves an identical query in the same session from the cache only", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("Cached context."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    const ctxA = { sessionKey: "agent:olivier:main", agentId: "olivier" };
    await cap.handler!({ prompt: "What is the ACME status?" }, ctxA);
    const second = await cap.handler!({ prompt: "what is the acme status" }, ctxA);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.ok(second?.prependContext?.includes("Cached context."));
    const timings = events(cap.infos).filter((e) => e.type === "timing");
    assert.equal(timings[1]!.cacheHit, 1);
    await cap.handler!({ prompt: "What is the ACME status?" }, { sessionKey: "agent:olivier:other", agentId: "olivier" });
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  it("can be disabled", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("ctx."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", cache: { enabled: false } });
    register(api);
    const ctx = { sessionKey: "agent:olivier:main" };
    await cap.handler!({ prompt: "What is the ACME status?" }, ctx);
    await cap.handler!({ prompt: "What is the ACME status?" }, ctx);
    assert.equal(fetchMock.mock.callCount(), 2);
  });
});

describe("4.0 — injection policies", () => {
  it("tool policy: no automatic retrieval, the tool still answers", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("Tool graph context."));
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      agents: { files: { injection: "tool" } },
      provenanceReport: "metadata",
    });
    register(api);
    const ctx = { agentId: "files", sessionKey: "agent:files:main", runId: "run-9" };
    assert.equal(await cap.handler!({ prompt: "find the signed contract" }, ctx), undefined);
    assert.equal(fetchMock.mock.callCount(), 0);
    const reasons = events(cap.infos).filter((e) => e.type === "router").map((e) => e.reason);
    assert.deepEqual(reasons, ["policy_tool"]);

    const tool = cap.toolFactory!({ agentId: "files", sessionKey: "agent:files:main" });
    const out = await tool.execute("call-1", { query: "signed contract ACME" });
    assert.equal(out.details.status, "ok");
    assert.ok(out.content[0]!.text.includes("Tool graph context."));
    // Provenance attached to the run the hook saw for this session.
    assert.equal(cap.emitted[0]?.runId, "run-9");
    assert.equal((cap.emitted[0]?.data as { injected?: { position?: string } }).injected?.position, "tool_result");
    // Tool calls default to the cheap `naive` mode.
    const body = JSON.parse(String((fetchMock.mock.calls[0]!.arguments[1] as RequestInit).body)) as { mode: string };
    assert.equal(body.mode, "naive");
  });

  it("hybrid policy: injects on a keyword hit, not on an ambiguous turn", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("Hybrid ctx."));
    const { api, cap } = makeHost({
      lightragUrl: "http://lr:9621",
      defaults: { injection: "hybrid" },
      jina: { router: { enabled: true, mode: "heuristic" } },
    });
    register(api);
    assert.equal(await cap.handler!({ prompt: "tell me something about the roadmap" }), undefined);
    assert.equal(fetchMock.mock.callCount(), 0);
    const hit = await cap.handler!({ prompt: "compare les offres de coaching" });
    assert.ok(hit?.prependContext?.includes("Hybrid ctx."));
  });

  it("off policy: nothing injected and the tool refuses", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("x"));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", defaults: { injection: "off" } });
    register(api);
    assert.equal(await cap.handler!({ prompt: "find the signed contract" }), undefined);
    const out = await cap.toolFactory!({}).execute("c", { query: "contract" });
    assert.equal(out.details.status, "disabled");
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("4.0 — knowledge_search tool guards", () => {
  const config = {
    geminiApiKey: "g",
    sources: {
      graph: { type: "lightrag", url: "http://lr:9621" },
      docs: { type: "pgvector", collections: ["knowledge_jerome"] },
    },
    agents: { denis: { sources: ["graph"] } },
    testMode: { enabled: true },
  };

  it("rejects sources outside the agent allowlist", async () => {
    const { api, cap } = makeHost(config);
    register(api);
    const out = await cap.toolFactory!({ agentId: "denis" }).execute("c", { query: "budget", sources: ["docs"] });
    assert.equal(out.details.status, "invalid");
    assert.ok(out.content[0]!.text.includes("docs"));
  });

  it("rejects collections that are not configured (tenant isolation)", async () => {
    const { api, cap } = makeHost(config);
    register(api);
    const out = await cap.toolFactory!({ agentId: "jerome" }).execute("c", {
      query: "budget",
      collection: "knowledge_olivier",
    });
    assert.equal(out.details.status, "invalid");
  });

  it("searches the allowed sources (TEST mode, no network)", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("no network in TEST mode");
    });
    const { api, cap } = makeHost(config);
    register(api);
    const out = await cap.toolFactory!({ agentId: "jerome" }).execute("c", {
      query: "Hélios",
      collection: "knowledge_jerome",
    });
    assert.equal(out.details.status, "ok");
    assert.ok(out.content[0]!.text.includes("Document Search Results (pgvector: docs)"));
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe("4.0 — control plane", () => {
  const config = {
    geminiApiKey: "g",
    sources: {
      graph: { type: "lightrag", label: "Graph", description: "KG", url: "http://lr:9621" },
      docs: { type: "pgvector", label: "Docs", collections: ["knowledge_jerome"] },
    },
    agents: {
      jerome: { sources: ["graph"], allowedSources: ["graph", "docs"] },
      denis: { sources: ["graph"] },
    },
  };
  const sessionKey = "agent:jerome:telegram:direct:42";

  it("knowledge.sources lists only the agent's sources, without secrets", () => {
    const { api, cap } = makeHost(config);
    register(api);
    let payload: Record<string, unknown> | undefined;
    cap.gatewayMethods["knowledge.sources"]!.handler({
      params: { agentId: "denis" },
      respond: (ok: boolean, p: Record<string, unknown>) => {
        assert.equal(ok, true);
        payload = p;
      },
    });
    const sources = payload!.sources as Array<Record<string, unknown>>;
    assert.deepEqual(sources.map((s) => s.id), ["graph"]);
    assert.equal(JSON.stringify(payload).includes("9621"), false);
  });

  it("policy.set validates against the allowlist and the hook honours it", async () => {
    const bodies: string[] = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      bodies.push(String(url));
      if (String(url).includes("generativelanguage")) {
        return new Response(JSON.stringify({ embedding: { values: [0.1] } }), { status: 200 });
      }
      return lightragResponse("Graph ctx.");
    });
    const { api, cap } = makeHost(config);
    register(api);
    const denied = (await cap.sessionActions["policy.set"]!.handler({
      sessionKey: "agent:denis:main",
      agentId: "denis",
      payload: { sources: ["docs"] },
    })) as { ok: boolean; code?: string; details?: { sourceId?: string } };
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "source_not_allowed");
    assert.equal(denied.details?.sourceId, "docs");

    const ok = (await cap.sessionActions["policy.set"]!.handler({
      sessionKey,
      agentId: "jerome",
      payload: { injection: "tool" },
    })) as { ok: boolean; result?: Record<string, unknown> };
    assert.equal(ok.ok, true);
    assert.equal(ok.result?.injection, "tool");
    assert.equal(
      (cap.store.get(sessionKey)?.["openclaw-knowledge"]?.policy as { injection?: string }).injection,
      "tool",
    );

    const result = await cap.handler!({ prompt: "what is the Hélios budget" }, { agentId: "jerome", sessionKey });
    assert.equal(result, undefined);
    assert.equal(bodies.length, 0);
  });

  it("a one-shot applies to exactly the next human turn and forces retrieval", async () => {
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      return lightragResponse("Graph ctx.");
    });
    const { api, cap } = makeHost(config);
    register(api);
    await cap.sessionActions["policy.set"]!.handler({
      sessionKey,
      agentId: "jerome",
      payload: { injection: "off", oneShot: { injection: "auto", sources: ["graph"] } },
    });
    // A heartbeat must NOT consume it.
    await cap.handler!({ prompt: "heartbeat check" }, { agentId: "jerome", sessionKey, trigger: "heartbeat" });
    // Even an acknowledgement is retrieved: the user explicitly asked.
    const first = await cap.handler!({ prompt: "merci" }, { agentId: "jerome", sessionKey, runId: "r1", trigger: "user" });
    assert.ok(first?.prependContext?.includes("Graph ctx."));
    await flush();
    const stored = cap.store.get(sessionKey)?.["openclaw-knowledge"]?.policy as Record<string, unknown>;
    assert.equal(stored.oneShot, undefined);
    assert.equal(stored.injection, "off");
    // Next turn: back to the session override (off).
    const second = await cap.handler!({ prompt: "what about the budget" }, { agentId: "jerome", sessionKey, runId: "r2" });
    assert.equal(second, undefined);
    assert.equal(urls.length, 1);
    const timing = events(cap.infos).filter((e) => e.type === "timing")[1]!;
    assert.deepEqual((timing.policy as { origin: unknown }).origin, { injection: "oneShot", sources: "oneShot" });
  });

  it("an acknowledgement does not consume a non-forcing one-shot", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => lightragResponse("Graph ctx."));
    const { api, cap } = makeHost(config);
    register(api);
    await cap.sessionActions["policy.set"]!.handler({
      sessionKey,
      agentId: "jerome",
      payload: { oneShot: { sources: ["graph"], force: false } },
    });
    assert.equal(await cap.handler!({ prompt: "merci" }, { agentId: "jerome", sessionKey, runId: "r1" }), undefined);
    await flush();
    const stored = cap.store.get(sessionKey)?.["openclaw-knowledge"]?.policy as { oneShot?: unknown };
    assert.ok(stored.oneShot, "one-shot must still be pending");
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("ignores a client-written (sessions.pluginPatch) disallowed source at read time", async () => {
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("generativelanguage")) {
        return new Response(JSON.stringify({ embedding: { values: [0.1] } }), { status: 200 });
      }
      return lightragResponse("Graph ctx.");
    });
    const { api, cap } = makeHost(config);
    register(api);
    // Raw write that bypasses plugin validation (admin sessions.pluginPatch).
    cap.store.set("agent:denis:main", {
      "openclaw-knowledge": { policy: { sources: ["docs"] } },
    });
    await cap.handler!({ prompt: "what is the budget" }, { agentId: "denis", sessionKey: "agent:denis:main" });
    assert.equal(urls.some((u) => u.includes("generativelanguage")), false);
    assert.ok(urls.some((u) => u.includes("lr:9621")));
    assert.ok(cap.warnings.some((w) => w.includes("not allowed")));
  });

  it("/knowledge command writes the same session state and replies without the LLM", async () => {
    const { api, cap } = makeHost(config);
    register(api);
    const reply = await cap.commands.knowledge!.handler({ args: "use docs", agentId: "jerome", sessionKey });
    assert.equal(reply.continueAgent, undefined);
    assert.ok(reply.text.includes("docs"));
    const stored = cap.store.get(sessionKey)?.["openclaw-knowledge"]?.policy as { sources?: string[] };
    assert.deepEqual(stored.sources, ["docs"]);
    const denied = await cap.commands.knowledge!.handler({ args: "use docs", agentId: "denis", sessionKey: "agent:denis:main" });
    assert.ok(denied.text.includes("not allowed"));
    const reset = await cap.commands.knowledge!.handler({ args: "reset", agentId: "jerome", sessionKey });
    assert.ok(reset.text.includes("(agent)"));
    assert.equal(cap.store.get(sessionKey)?.["openclaw-knowledge"], undefined);
  });

  it("knowledge.policy.get returns the effective policy without consuming a one-shot", async () => {
    const { api, cap } = makeHost(config);
    register(api);
    await cap.sessionActions["policy.set"]!.handler({
      sessionKey,
      agentId: "jerome",
      payload: { oneShot: { sources: ["docs"] } },
    });
    let payload: Record<string, unknown> | undefined;
    cap.gatewayMethods["knowledge.policy.get"]!.handler({
      params: { sessionKey },
      respond: (_ok: boolean, p: Record<string, unknown>) => (payload = p),
    });
    assert.equal(payload!.agentId, "jerome");
    assert.deepEqual(payload!.effectiveSources, ["graph"]);
    assert.ok((payload!.session as { oneShot?: unknown }).oneShot);
    const stored = cap.store.get(sessionKey)?.["openclaw-knowledge"]?.policy as { oneShot?: unknown };
    assert.ok(stored.oneShot);
  });

  it("projects a sanitized session extension value", () => {
    const { api, cap } = makeHost(config);
    register(api);
    const projected = cap.sessionExtension!.project!({
      sessionKey,
      state: { injection: "tool", lastOneShot: { sources: ["graph"], runId: "x" }, bogus: 1 },
    }) as Record<string, unknown>;
    assert.deepEqual(projected, { v: 1, injection: "tool" });
  });
});

describe("4.0 — currentUserMessage", () => {
  it("prefers currentUserMessage over the reconstructed prompt", async () => {
    const bodies: Array<{ query: string }> = [];
    mock.method(globalThis, "fetch", async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { query: string });
      return lightragResponse("ctx");
    });
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    await cap.handler!({ prompt: "old history ... current question", currentUserMessage: "current question please" });
    assert.equal(bodies[0]!.query, "current question please");
    // Explicit empty string = no textual request → no retrieval, no fallback.
    assert.equal(await cap.handler!({ prompt: "history text here", currentUserMessage: "" }), undefined);
    assert.equal(bodies.length, 1);
  });
});

describe("4.0 — review regressions", () => {
  it("attaches tool provenance to the current run even when the hook skipped it", async () => {
    mock.method(globalThis, "fetch", async () => lightragResponse("Tool graph context."));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621", provenanceReport: "metadata" });
    register(api);
    const sessionKey = "agent:olivier:main";
    await cap.handler!({ prompt: "who works on the ACME project?" }, { agentId: "olivier", sessionKey, runId: "human-1", trigger: "user" });
    await cap.handler!({ prompt: "run the heartbeat checklist" }, { agentId: "olivier", sessionKey, runId: "hb-2", trigger: "heartbeat" });
    cap.emitted.length = 0;
    const tool = cap.toolFactory!({ agentId: "olivier", sessionKey });
    const out = await tool.execute("call-1", { query: "ACME contract" });
    assert.equal(out.details.status, "ok");
    assert.equal(cap.emitted[0]?.runId, "hb-2");
  });

  it("never logs a LightRAG error body (it can echo the query)", async () => {
    assert.equal(sanitizeSourceError(new Error("LightRAG query failed (500): secret question text")), "Error (HTTP 500)");
    mock.method(globalThis, "fetch", async () => new Response("echo: secret question text", { status: 422 }));
    const { api, cap } = makeHost({ lightragUrl: "http://lr:9621" });
    register(api);
    await cap.handler!({ prompt: "secret question text about ACME" });
    assert.ok(cap.errors.some((m) => m.includes("HTTP 422")));
    assert.ok(!cap.errors.some((m) => m.includes("secret question")));
  });

  it("keeps the global circuit breaker open across re-registrations", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("down", { status: 500 }));
    const first = makeHost({ lightragUrl: "http://lr:9621" });
    register(first.api);
    for (let i = 0; i < 3; i++) await first.cap.handler!({ prompt: `question number ${i} about ACME` });
    const calls = fetchMock.mock.callCount();
    // The host re-registers the plugin for the next run.
    const second = makeHost({ lightragUrl: "http://lr:9621" });
    register(second.api);
    assert.equal(await second.cap.handler!({ prompt: "another question about ACME" }), undefined);
    assert.equal(fetchMock.mock.callCount(), calls);
  });

  it("surfaces a validation error even though the host write was aborted", async () => {
    const { api, cap } = makeHost({
      sources: { graph: { type: "lightrag", url: "http://lr:9621" } },
    });
    register(api);
    const res = (await cap.sessionActions["policy.set"]!.handler({
      sessionKey: "agent:olivier:main",
      agentId: "olivier",
      payload: { sources: ["nope"] },
    })) as { ok: boolean; code?: string };
    assert.equal(res.ok, false);
    assert.equal(res.code, "unknown_source");
    assert.equal(cap.store.get("agent:olivier:main"), undefined);
  });
});
