// Unit tests for config helpers (resolveEnv + resolveConfig).
//
// Uses Node's built-in test runner so we stay dependency-free.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { resolveEnv, resolveConfig } from "../src/config.js";

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

describe("resolveConfig", () => {
  it("applies defaults for an empty config", () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.topK, 5);
    assert.equal(cfg.scoreThreshold, 0.3);
    assert.equal(cfg.maxInjectChars, 4000);
    assert.equal(cfg.lightragQueryMode, "hybrid");
    assert.equal(cfg.lightragMaxChars, 4000);
    assert.deepEqual(cfg.collections, ["knowledge_default"]);
  });

  it("derives pgvectorEnabled from presence of geminiApiKey", () => {
    const without = resolveConfig({});
    assert.equal(without.pgvectorEnabled, false);

    const withKey = resolveConfig({ geminiApiKey: "k" });
    assert.equal(withKey.pgvectorEnabled, true);
  });

  it("honors explicit pgvectorEnabled=false even with geminiApiKey", () => {
    const cfg = resolveConfig({ geminiApiKey: "k", pgvectorEnabled: false });
    assert.equal(cfg.pgvectorEnabled, false);
  });

  it("derives lightragEnabled from presence of lightragUrl", () => {
    const without = resolveConfig({});
    assert.equal(without.lightragEnabled, false);

    const withUrl = resolveConfig({ lightragUrl: "http://lr:9621" });
    assert.equal(withUrl.lightragEnabled, true);
  });

  it("honors explicit lightragEnabled=false even with lightragUrl", () => {
    const cfg = resolveConfig({
      lightragUrl: "http://lr:9621",
      lightragEnabled: false,
    });
    assert.equal(cfg.lightragEnabled, false);
  });

  it("accepts empty config and no argument", () => {
    assert.doesNotThrow(() => resolveConfig({}));
    assert.doesNotThrow(() => resolveConfig());
  });
});

describe("resolveConfig — Jina nested block (v3.2.0)", () => {
  it("defaults all Jina features to OFF when the jina block is absent", () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.jinaApiKey, "");
    assert.equal(cfg.routerEnabled, false);
    assert.equal(cfg.routerMode, "heuristic");
    assert.equal(cfg.routerClassifierId, "");
    assert.equal(cfg.routerMinConfidence, 0.35);
    assert.equal(cfg.pgvectorRerankerEnabled, false);
    assert.equal(cfg.pgvectorRerankerModel, "jina-reranker-v2-base-multilingual");
    assert.equal(cfg.pgvectorRerankerTopN, 5);
    // v3.2.4 defaults
    assert.equal(cfg.pgvectorRerankerCandidatePoolMax, 20);
    assert.equal(cfg.pgvectorRerankerMaxCharsPerDoc, 2000);
    assert.equal(cfg.jinaRpmBudget, 60);
  });

  it("honors pgvectorReranker.candidatePoolMax + maxCharsPerDoc overrides (v3.2.4)", () => {
    const cfg = resolveConfig({
      jina: {
        apiKey: "k",
        pgvectorReranker: {
          enabled: true,
          candidatePoolMax: 5,
          maxCharsPerDoc: 800,
        },
      },
    });
    assert.equal(cfg.pgvectorRerankerCandidatePoolMax, 5);
    assert.equal(cfg.pgvectorRerankerMaxCharsPerDoc, 800);
  });

  it("clamps negative / non-finite candidatePoolMax + maxCharsPerDoc to 0 (defense-in-depth)", () => {
    const c1 = resolveConfig({
      jina: { pgvectorReranker: { candidatePoolMax: -1, maxCharsPerDoc: -100 } },
    });
    assert.equal(c1.pgvectorRerankerCandidatePoolMax, 0);
    assert.equal(c1.pgvectorRerankerMaxCharsPerDoc, 0);

    const c2 = resolveConfig({
      jina: {
        pgvectorReranker: {
          candidatePoolMax: Number.NaN,
          maxCharsPerDoc: Number.POSITIVE_INFINITY,
        },
      },
    });
    assert.equal(c2.pgvectorRerankerCandidatePoolMax, 0);
    assert.equal(c2.pgvectorRerankerMaxCharsPerDoc, 0);
  });

  it("honors jina.rpmBudget override (v3.2.4)", () => {
    const cfg = resolveConfig({ jina: { apiKey: "k", rpmBudget: 30 } });
    assert.equal(cfg.jinaRpmBudget, 30);
  });

  it("clamps negative / non-finite rpmBudget to 0 (v3.2.4)", () => {
    assert.equal(
      resolveConfig({ jina: { rpmBudget: -5 } }).jinaRpmBudget,
      0,
    );
    assert.equal(
      resolveConfig({ jina: { rpmBudget: Number.NaN } }).jinaRpmBudget,
      0,
    );
  });

  it("honors router.minConfidence override", () => {
    const cfg = resolveConfig({
      jina: { apiKey: "k", router: { enabled: true, minConfidence: 0.5 } },
    });
    assert.equal(cfg.routerMinConfidence, 0.5);
  });

  it("clamps router.minConfidence into [0, 1] and rejects non-finite values", () => {
    // The JSON schema enforces this bound for well-formed configs, but
    // we clamp defensively to avoid a misconfigured value breaking the
    // classifier comparison silently. Pin the contract in tests.
    assert.equal(
      resolveConfig({ jina: { router: { minConfidence: -0.3 } } }).routerMinConfidence,
      0,
    );
    assert.equal(
      resolveConfig({ jina: { router: { minConfidence: 1.7 } } }).routerMinConfidence,
      1,
    );
    assert.equal(
      resolveConfig({ jina: { router: { minConfidence: Number.NaN } } }).routerMinConfidence,
      0,
    );
    assert.equal(
      resolveConfig({ jina: { router: { minConfidence: Number.POSITIVE_INFINITY } } })
        .routerMinConfidence,
      0,
    );
  });

  it("substitutes ${ENV} in jina.apiKey", () => {
    process.env.MY_JINA_KEY = "jina_xyz";
    try {
      const cfg = resolveConfig({ jina: { apiKey: "${MY_JINA_KEY}" } });
      assert.equal(cfg.jinaApiKey, "jina_xyz");
    } finally {
      delete process.env.MY_JINA_KEY;
    }
  });

  it("activates the router only when explicitly enabled", () => {
    const off = resolveConfig({ jina: { apiKey: "k" } });
    assert.equal(off.routerEnabled, false);

    const on = resolveConfig({ jina: { apiKey: "k", router: { enabled: true } } });
    assert.equal(on.routerEnabled, true);
  });

  it("honors router.mode and router.classifierId", () => {
    const cfg = resolveConfig({
      jina: {
        apiKey: "k",
        router: {
          enabled: true,
          mode: "jina-classifier",
          classifierId: "my-id",
        },
      },
    });
    assert.equal(cfg.routerMode, "jina-classifier");
    assert.equal(cfg.routerClassifierId, "my-id");
  });

  it("substitutes ${ENV} in router.classifierId", () => {
    process.env.MY_CLASSIFIER_ID = "trained-2026-05";
    try {
      const cfg = resolveConfig({
        jina: { apiKey: "k", router: { classifierId: "${MY_CLASSIFIER_ID}" } },
      });
      assert.equal(cfg.routerClassifierId, "trained-2026-05");
    } finally {
      delete process.env.MY_CLASSIFIER_ID;
    }
  });

  it("activates pgvector reranker only when enabled AND jina.apiKey is present", () => {
    const noKey = resolveConfig({
      jina: { pgvectorReranker: { enabled: true } },
    });
    assert.equal(noKey.pgvectorRerankerEnabled, false);

    const noToggle = resolveConfig({
      jina: { apiKey: "k" },
    });
    assert.equal(noToggle.pgvectorRerankerEnabled, false);

    const both = resolveConfig({
      jina: { apiKey: "k", pgvectorReranker: { enabled: true } },
    });
    assert.equal(both.pgvectorRerankerEnabled, true);
  });

  it("honors pgvectorReranker.model and topN overrides", () => {
    const cfg = resolveConfig({
      jina: {
        apiKey: "k",
        pgvectorReranker: {
          enabled: true,
          model: "jina-reranker-v3",
          topN: 10,
        },
      },
    });
    assert.equal(cfg.pgvectorRerankerModel, "jina-reranker-v3");
    assert.equal(cfg.pgvectorRerankerTopN, 10);
  });
});

describe("resolveConfig — TEST mode (v3.2.7)", () => {
  it("defaults testMode to OFF and resolves realistic default mocks", () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.testModeEnabled, false);
    // Default LightRAG mock is realistic and > 200 chars (not sparse).
    assert.ok(cfg.lightragMockResponse.length > 200);
    assert.ok(cfg.lightragMockResponse.includes("{{query}}"));
    // Default pgvector mocks are normalized full rows, score-sorted desc.
    assert.ok(cfg.pgvectorMockResults.length >= 2);
    assert.ok(
      cfg.pgvectorMockResults[0]!.score >= cfg.pgvectorMockResults[1]!.score,
    );
    assert.equal(cfg.pgvectorMockResults[0]!.mime_type, null);
  });

  it("enables BOTH sources when testMode is on, even without creds/URL", () => {
    // No geminiApiKey, no lightragUrl — normally both sources are disabled.
    const off = resolveConfig({});
    assert.equal(off.pgvectorEnabled, false);
    assert.equal(off.lightragEnabled, false);

    const on = resolveConfig({ testMode: { enabled: true } });
    assert.equal(on.testModeEnabled, true);
    assert.equal(on.pgvectorEnabled, true);
    assert.equal(on.lightragEnabled, true);
  });

  it("lets an explicit source disable win over testMode (mock one source)", () => {
    const lrOnly = resolveConfig({
      testMode: { enabled: true },
      pgvectorEnabled: false,
    });
    assert.equal(lrOnly.pgvectorEnabled, false);
    assert.equal(lrOnly.lightragEnabled, true);

    const pgOnly = resolveConfig({
      testMode: { enabled: true },
      lightragEnabled: false,
    });
    assert.equal(pgOnly.pgvectorEnabled, true);
    assert.equal(pgOnly.lightragEnabled, false);
  });

  it("honors a custom lightragMockResponse verbatim", () => {
    const cfg = resolveConfig({
      testMode: { enabled: true, lightragMockResponse: "custom ctx {{query}}" },
    });
    assert.equal(cfg.lightragMockResponse, "custom ctx {{query}}");
  });

  it("normalizes custom pgvector mocks: nulls, default collection, score, sort", () => {
    const cfg = resolveConfig({
      collections: ["knowledge_alice"],
      testMode: {
        enabled: true,
        pgvectorMockResults: [
          { file_name: "low.md", text: "low", score: 0.2 },
          { file_name: "high.md", text: "high", score: 0.9 },
          { text: "no-name-no-score" }, // score → 0.8, collection → collections[0]
        ],
      },
    });
    const rows = cfg.pgvectorMockResults;
    assert.equal(rows.length, 3);
    // Sorted by descending score: 0.9, 0.8 (default), 0.2
    assert.deepEqual(
      rows.map((r) => r.score),
      [0.9, 0.8, 0.2],
    );
    // Missing collection falls back to the first configured collection.
    const noName = rows.find((r) => r.file_name === null);
    assert.ok(noName);
    assert.equal(noName!.collection, "knowledge_alice");
    // Unspecified fields are null, not undefined.
    assert.equal(rows[0]!.file_id, null);
    assert.equal(rows[0]!.timestamp_start, null);
  });

  it("clamps mock scores into [0, 1]", () => {
    const cfg = resolveConfig({
      testMode: {
        enabled: true,
        pgvectorMockResults: [
          { file_name: "a", text: "a", score: 1.7 },
          { file_name: "b", text: "b", score: -0.5 },
        ],
      },
    });
    const scores = cfg.pgvectorMockResults.map((r) => r.score);
    assert.ok(scores.every((s) => s >= 0 && s <= 1));
  });

  it("resolves default LightRAG mock references (v3.2.9)", () => {
    const cfg = resolveConfig({});
    assert.ok(cfg.lightragMockReferences.length >= 2);
    assert.ok(
      cfg.lightragMockReferences.every(
        (r) => typeof r.file_path === "string" && r.file_path.length > 0,
      ),
    );
  });

  it("maps custom lightragMockReferences (string[]) to {file_path} objects", () => {
    const cfg = resolveConfig({
      testMode: {
        enabled: true,
        lightragMockReferences: ["secret-plan.md", "roadmap.md"],
      },
    });
    assert.deepEqual(cfg.lightragMockReferences, [
      { file_path: "secret-plan.md" },
      { file_path: "roadmap.md" },
    ]);
  });

  it("drops empty / non-string mock reference entries (defense-in-depth)", () => {
    const cfg = resolveConfig({
      testMode: {
        enabled: true,
        // @ts-expect-error — exercise the runtime guard against bad input
        lightragMockReferences: ["ok.md", "", 42, null, "also-ok.md"],
      },
    });
    assert.deepEqual(cfg.lightragMockReferences, [
      { file_path: "ok.md" },
      { file_path: "also-ok.md" },
    ]);
  });

  it("honors an explicit empty lightragMockReferences list (no attribution)", () => {
    const cfg = resolveConfig({
      testMode: { enabled: true, lightragMockReferences: [] },
    });
    assert.deepEqual(cfg.lightragMockReferences, []);
  });
});

describe("resolveConfig — 4.0 keys", () => {
  it("applies 4.0 defaults", () => {
    const cfg = resolveConfig({ lightragUrl: "http://lr:9621" });
    assert.equal(cfg.injectionTarget, "prependContext");
    assert.equal(cfg.lightragTimeoutMs, 3500);
    assert.equal(cfg.pgvectorTimeoutMs, 3000);
    assert.equal(cfg.retrievalBudgetMs, 4500);
    assert.equal(cfg.hookTimeoutMs, 6000);
    assert.equal(cfg.routerTimeoutMs, 1500);
    assert.equal(cfg.lightragLocalKeywords, false);
    assert.equal(cfg.lightragQueryModeExplicit, false);
    assert.deepEqual(cfg.lightragQueryModeByRoute, {
      PGVECTOR_ONLY: "naive",
      LIGHTRAG_ONLY: "hybrid",
      ALL: "hybrid",
      fallback: "hybrid",
      tool: "naive",
    });
    assert.deepEqual(cfg.skip, {
      sessionPatterns: [":subagent:", ":active-memory:"],
      triggers: ["heartbeat", "cron", "memory", "manual"],
      nonHumanInput: true,
      allowSourceTools: [],
      acknowledgements: true,
    });
    assert.deepEqual(cfg.cache, { enabled: true, ttlMs: 600000, maxEntries: 200, maxBytes: 8388608 });
    assert.equal(cfg.hybridMinScore, 0.45);
    assert.deepEqual(cfg.tool, { enabled: true, maxTopK: 20 });
    assert.deepEqual(cfg.controlPlane, {
      sessionOverrides: true,
      oneShotTtlMs: 600000,
      command: true,
      gatewayMethods: true,
    });
    assert.deepEqual(cfg.configWarnings, []);
  });

  it("an explicit legacy lightragQueryMode overrides every route default", () => {
    const cfg = resolveConfig({ lightragUrl: "x", lightragQueryMode: "mix" });
    assert.equal(cfg.lightragQueryModeExplicit, true);
    assert.equal(cfg.lightragQueryModeByRoute.PGVECTOR_ONLY, "mix");
    assert.equal(cfg.lightragQueryModeByRoute.tool, "mix");
  });

  it("lightragQueryModeByRoute entries win and are tracked as explicit", () => {
    const cfg = resolveConfig({
      lightragUrl: "x",
      lightragQueryMode: "hybrid",
      lightragQueryModeByRoute: { fallback: "naive", ALL: "bogus" as never },
    });
    assert.equal(cfg.lightragQueryModeByRoute.fallback, "naive");
    assert.equal(cfg.lightragQueryModeByRoute.ALL, "hybrid");
    assert.deepEqual(cfg.lightragQueryModeByRouteExplicit, ["fallback"]);
  });

  it("raises a hookTimeoutMs below the retrieval budget and warns", () => {
    const cfg = resolveConfig({ lightragUrl: "x", retrievalBudgetMs: 8000, hookTimeoutMs: 5000 });
    assert.equal(cfg.hookTimeoutMs, 9500);
    assert.ok(cfg.configWarnings.some((w) => w.includes("hookTimeoutMs=5000")));
    const ok = resolveConfig({ lightragUrl: "x", retrievalBudgetMs: 3000, hookTimeoutMs: 6000 });
    assert.equal(ok.hookTimeoutMs, 6000);
    assert.ok(!ok.configWarnings.some((w) => w.includes("hookTimeoutMs")));
  });

  it("derives hookTimeoutMs from the budget and clamps bad values", () => {
    const cfg = resolveConfig({
      lightragUrl: "x",
      retrievalBudgetMs: 3000,
      lightragTimeoutMs: -1,
      injectionTarget: "systemPrompt" as never,
      jina: { router: { mode: "jina-classifier-parallel", timeoutMs: 800 } },
    });
    assert.equal(cfg.hookTimeoutMs, 4500);
    assert.equal(cfg.lightragTimeoutMs, 3500);
    assert.equal(cfg.injectionTarget, "prependContext");
    assert.equal(cfg.routerMode, "jina-classifier-parallel");
    assert.equal(cfg.routerTimeoutMs, 800);
  });

  it("falls back to heuristic for an unknown router mode", () => {
    const cfg = resolveConfig({ lightragUrl: "x", jina: { router: { mode: "magic" as never } } });
    assert.equal(cfg.routerMode, "heuristic");
  });
});
