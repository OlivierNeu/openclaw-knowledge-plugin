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
    assert.equal(cfg.pgvectorRerankerEnabled, false);
    assert.equal(cfg.pgvectorRerankerModel, "jina-reranker-v2-base-multilingual");
    assert.equal(cfg.pgvectorRerankerTopN, 5);
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
