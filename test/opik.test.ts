// Opik export (4.0.0): exporter batching / bounds / failure handling, config
// resolution, and the hook + tool integration (content-free payloads).

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import {
  flushOpikForTests,
  registerKnowledgePlugin,
  resetSharedStateForTests,
} from "../src/index.js";
import { OpikExporter, uuidv7 } from "../src/tracing/opik.js";
import type { ResolvedOpikConfig } from "../src/types.js";

const baseOpik: ResolvedOpikConfig = {
  enabled: true,
  apiUrl: "https://opik.test/api",
  apiKey: "k-123",
  workspace: "ws",
  projectName: "proj",
  includeSkipped: false,
  flushIntervalMs: 60_000,
  maxQueue: 500,
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown[]>;
}

function recordingFetch(calls: Call[], status = 200) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown[]>,
    });
    return new Response("{}", { status });
  };
}

function trace(name: string, startedAt = 1_790_000_000_000) {
  return {
    name,
    startedAt,
    endedAt: startedAt + 1200,
    metadata: { agentId: "denis", skipped: null, absent: undefined },
    tags: ["knowledge"],
    spans: [{ name: "lightrag:graph", startedAt: startedAt + 10, endedAt: startedAt + 900, metadata: { status: "ok" } }],
  };
}

afterEach(() => {
  mock.restoreAll();
  resetSharedStateForTests();
});

describe("opik — uuidv7", () => {
  it("emits RFC 9562 version-7 ids ordered by time", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(a < b);
  });
});

describe("opik — exporter", () => {
  it("posts traces then spans with the Opik headers", async () => {
    const calls: Call[] = [];
    const exporter = new OpikExporter(baseOpik, { warn: () => undefined }, recordingFetch(calls));
    exporter.record(trace("knowledge.retrieval"));
    await exporter.flush();
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://opik.test/api/v1/private/traces/batch", "https://opik.test/api/v1/private/spans/batch"],
    );
    assert.equal(calls[0]!.headers.Authorization, "k-123");
    assert.equal(calls[0]!.headers["Comet-Workspace"], "ws");
    const row = calls[0]!.body.traces![0] as Record<string, unknown>;
    assert.equal(row.project_name, "proj");
    assert.equal(row.start_time, new Date(1_790_000_000_000).toISOString());
    assert.deepEqual(row.metadata, { agentId: "denis", skipped: null });
    const span = calls[1]!.body.spans![0] as Record<string, unknown>;
    assert.equal(span.trace_id, row.id);
    assert.equal(span.type, "general");
  });

  it("keeps the queue bounded by dropping the oldest traces and their spans", async () => {
    const calls: Call[] = [];
    const exporter = new OpikExporter({ ...baseOpik, maxQueue: 2 }, { warn: () => undefined }, recordingFetch(calls));
    for (let i = 0; i < 3; i++) exporter.record(trace(`t${i}`, 1_790_000_000_000 + i));
    assert.equal(exporter.pending, 2);
    await exporter.flush();
    const names = (calls[0]!.body.traces as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names, ["t1", "t2"]);
    assert.equal(calls[1]!.body.spans!.length, 2);
  });

  it("swallows HTTP failures with a single status-only warning", async () => {
    const warnings: string[] = [];
    const exporter = new OpikExporter(baseOpik, { warn: (m) => warnings.push(m) }, recordingFetch([], 500));
    exporter.record(trace("a"));
    await exporter.flush();
    exporter.record(trace("b"));
    await exporter.flush();
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("HTTP 500"));
    assert.equal(exporter.pending, 0);
  });

  it("does nothing when disabled", async () => {
    const calls: Call[] = [];
    const exporter = new OpikExporter({ ...baseOpik, enabled: false }, { warn: () => undefined }, recordingFetch(calls));
    exporter.record(trace("a"));
    await exporter.flush();
    assert.equal(calls.length, 0);
  });
});

describe("opik — config", () => {
  it("stays disabled with a warning when no API key is available", () => {
    const saved = process.env.OPIK_API_KEY;
    delete process.env.OPIK_API_KEY;
    try {
      const cfg = resolveConfig({ lightragUrl: "x", opik: { enabled: true } });
      assert.equal(cfg.opik.enabled, false);
      assert.ok(cfg.configWarnings.some((w) => w.includes("opik.enabled")));
    } finally {
      if (saved !== undefined) process.env.OPIK_API_KEY = saved;
    }
  });

  it("falls back to OPIK_API_KEY and the Opik Cloud URL", () => {
    const saved = process.env.OPIK_API_KEY;
    process.env.OPIK_API_KEY = "from-env";
    try {
      const cfg = resolveConfig({ lightragUrl: "x", opik: { enabled: true, projectName: "openclaw-jerome" } });
      assert.equal(cfg.opik.enabled, true);
      assert.equal(cfg.opik.apiKey, "from-env");
      assert.equal(cfg.opik.apiUrl, "https://www.comet.com/opik/api");
      assert.equal(cfg.opik.projectName, "openclaw-jerome");
    } finally {
      if (saved === undefined) delete process.env.OPIK_API_KEY;
      else process.env.OPIK_API_KEY = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Hook + tool integration
// ---------------------------------------------------------------------------

type Handler = (event: { prompt: string }, ctx?: Record<string, unknown>) => Promise<unknown>;

function makeApi(pluginConfig: Record<string, unknown>) {
  const cap: { handler?: Handler; toolFactory?: (ctx: Record<string, unknown>) => { execute: (id: string, p: unknown) => Promise<unknown> } } = {};
  const api = {
    id: "openclaw-knowledge",
    pluginConfig,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    on: (_name: string, handler: Handler) => {
      cap.handler = handler;
    },
    registerTool: (factory: (ctx: Record<string, unknown>) => never) => {
      cap.toolFactory = factory;
    },
  };
  return { api, cap };
}

function mockNetwork(opikBodies: Array<{ url: string; body: string }>) {
  mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://opik.test")) {
      opikBodies.push({ url: u, body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }
    return new Response(
      JSON.stringify({ response: "Graph context about Hélios.", references: [{ file_path: "gdrive/abc" }] }),
      { status: 200 },
    );
  });
}

const opikConfig = { enabled: true, apiUrl: "https://opik.test/api", apiKey: "k", projectName: "openclaw-test" };

describe("opik — hook and tool integration", () => {
  it("exports one content-free knowledge.retrieval trace per retrieval", async () => {
    const opik: Array<{ url: string; body: string }> = [];
    mockNetwork(opik);
    const { api, cap } = makeApi({ lightragUrl: "http://lr:9621", opik: opikConfig });
    registerKnowledgePlugin(api as never);
    const query = "quel est le budget confidentiel du projet Hélios";
    await cap.handler!({ prompt: query }, { agentId: "denis", sessionKey: "agent:denis:telegram:direct:424242", runId: "run-7", trigger: "user" });
    await flushOpikForTests();

    const traces = opik.find((c) => c.url.endsWith("/traces/batch"))!;
    const spans = opik.find((c) => c.url.endsWith("/spans/batch"))!;
    const row = (JSON.parse(traces.body) as { traces: Array<Record<string, unknown>> }).traces[0]!;
    assert.equal(row.name, "knowledge.retrieval");
    assert.equal(row.project_name, "openclaw-test");
    const meta = row.metadata as Record<string, unknown>;
    assert.equal(meta.runId, "run-7");
    assert.equal(meta.agentId, "denis");
    assert.equal(meta.injected, true);
    assert.ok((row.tags as string[]).includes("agent:denis"));
    const spanNames = (JSON.parse(spans.body) as { spans: Array<{ name: string }> }).spans.map((s) => s.name);
    assert.ok(spanNames.includes("lightrag:lightrag"));
    // Content-free: no query text, retrieved text, document path or session key.
    for (const call of opik) {
      assert.ok(!call.body.includes("Hélios"), "query / context must not be exported");
      assert.ok(!call.body.includes("gdrive/abc"), "document paths must not be exported");
      assert.ok(!call.body.includes("424242"), "session key must not be exported");
    }
  });

  it("does not export turns skipped before routing", async () => {
    const opik: Array<{ url: string; body: string }> = [];
    mockNetwork(opik);
    const { api, cap } = makeApi({ lightragUrl: "http://lr:9621", opik: opikConfig });
    registerKnowledgePlugin(api as never);
    await cap.handler!({ prompt: "run the heartbeat checklist" }, { agentId: "denis", sessionKey: "agent:denis:main", runId: "hb", trigger: "heartbeat" });
    await flushOpikForTests();
    assert.equal(opik.length, 0);
  });

  it("exports knowledge_search calls as knowledge.search traces", async () => {
    const opik: Array<{ url: string; body: string }> = [];
    mockNetwork(opik);
    const { api, cap } = makeApi({ lightragUrl: "http://lr:9621", opik: opikConfig });
    registerKnowledgePlugin(api as never);
    const tool = cap.toolFactory!({ agentId: "files", sessionKey: "agent:files:main" });
    await tool.execute("call-1", { query: "contrat signé Hélios" });
    await flushOpikForTests();
    const row = (JSON.parse(opik.find((c) => c.url.endsWith("/traces/batch"))!.body) as { traces: Array<Record<string, unknown>> }).traces[0]!;
    assert.equal(row.name, "knowledge.search");
    assert.ok((row.tags as string[]).includes("tool"));
    assert.ok(!opik.some((c) => c.body.includes("Hélios")));
  });
});
