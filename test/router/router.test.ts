// Unit tests for the router orchestrator.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { decideRoute } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/index.js";

const BASE_CFG: RouterConfig = {
  enabled: true,
  mode: "jina-classifier",
  jinaApiKey: "jina_test",
};

describe("decideRoute — disabled router", () => {
  it("returns ALL with reason router_disabled", async () => {
    const d = await decideRoute({ ...BASE_CFG, enabled: false }, { query: "anything" });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "router_disabled");
    assert.equal(d.score, null);
  });

  it("does not call the classifier when disabled", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    await decideRoute({ ...BASE_CFG, enabled: false }, { query: "anything" });
    assert.equal(fetchCalled, false);
  });
});

describe("decideRoute — heuristic short-circuits", () => {
  afterEach(() => mock.restoreAll());

  it("returns NONE on heartbeat trigger without classifier call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const d = await decideRoute(BASE_CFG, { query: "x", trigger: "heartbeat" });
    assert.equal(d.route, "NONE");
    assert.equal(d.reason, "heuristic_trigger");
    assert.equal(fetchCalled, false);
  });

  it("returns NONE on meta-agent question without classifier call", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const d = await decideRoute(BASE_CFG, { query: "what is your session id?" });
    assert.equal(d.route, "NONE");
    assert.equal(d.reason, "heuristic_meta");
    assert.equal(fetchCalled, false);
  });

  it("routes to PGVECTOR_ONLY via keyword fast-path", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const d = await decideRoute(BASE_CFG, { query: "quelle version d'OpenClaw ?" });
    assert.equal(d.route, "PGVECTOR_ONLY");
    assert.equal(d.reason, "heuristic_keyword");
    assert.equal(fetchCalled, false);
  });
});

describe("decideRoute — heuristic-only mode", () => {
  afterEach(() => mock.restoreAll());

  it("returns ALL with classifier_fallback when heuristic is ambiguous", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const cfg: RouterConfig = { ...BASE_CFG, mode: "heuristic" };
    const d = await decideRoute(cfg, { query: "rappelle-moi ce qu'on a fait hier" });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_fallback");
    assert.equal(fetchCalled, false);
  });
});

describe("decideRoute — Jina classifier success", () => {
  afterEach(() => mock.restoreAll());

  it("calls /v1/classify in zero-shot when no classifierId", async () => {
    let capturedBody: Record<string, unknown> = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "LIGHTRAG_ONLY: knowledge graph question about entities and their relationships — which client, which coach, which mission, which programme links to which livrable",
                  score: 0.81,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    });

    const d = await decideRoute(BASE_CFG, {
      query: "raconte-moi l'historique de la mission ABC",
    });
    assert.equal(d.route, "LIGHTRAG_ONLY");
    assert.equal(d.reason, "classifier_hit");
    assert.equal(d.score, 0.81);
    // Zero-shot uses labels[], no classifier_id
    assert.ok(Array.isArray(capturedBody["labels"]));
    assert.equal(capturedBody["classifier_id"], undefined);
  });

  it("calls /v1/classify in few-shot when classifierId provided", async () => {
    let capturedBody: Record<string, unknown> = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      // Few-shot classifiers are expected to be trained with the canonical
      // Route names — "PGVECTOR_ONLY", "LIGHTRAG_ONLY", "ALL", "NONE".
      return new Response(
        JSON.stringify({ results: [{ label: "PGVECTOR_ONLY", score: 0.91 }] }),
        { status: 200 },
      );
    });

    const d = await decideRoute(
      { ...BASE_CFG, classifierId: "openclaw-router-v1" },
      { query: "rappelle-moi le contenu de ce paragraphe" },
    );
    assert.equal(d.route, "PGVECTOR_ONLY");
    assert.equal(d.reason, "classifier_hit");
    assert.equal(d.score, 0.91);
    assert.equal(capturedBody["classifier_id"], "openclaw-router-v1");
    assert.equal(capturedBody["labels"], undefined);
  });

  it("falls back to ALL when a few-shot classifier returns an unknown label", async () => {
    // A misconfigured few-shot classifier may return labels that are NOT
    // canonical Route names. The classifier filters these out via
    // `expectedLabels`, so the outcome reaches decideRoute as `null` and
    // we lose the score — that is the expected and audited behavior
    // (we never propagate hallucinated classifications).
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ results: [{ label: "MISCONFIGURED", score: 0.99 }] }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, classifierId: "openclaw-router-v1" },
      { query: "rappelle-moi le contenu de ce paragraphe" },
    );
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_fallback");
    assert.equal(d.score, null);
  });
});

describe("decideRoute — fail-open semantics", () => {
  afterEach(() => mock.restoreAll());

  it("falls back to ALL on classifier null result", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const d = await decideRoute(BASE_CFG, {
      query: "rappelle-moi ce qu'on a fait hier",
    });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_fallback");
  });

  it("falls back to ALL on Jina API error", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response("rate limited", { status: 429 }),
    );

    const d = await decideRoute(BASE_CFG, {
      query: "rappelle-moi ce qu'on a fait hier",
    });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_error");
  });

  it("falls back to ALL on network error", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNRESET");
    });

    const d = await decideRoute(BASE_CFG, {
      query: "rappelle-moi ce qu'on a fait hier",
    });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_error");
  });

  it("falls back to ALL when jinaApiKey is missing", async () => {
    let fetchCalled = false;
    mock.method(globalThis, "fetch", async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });

    const d = await decideRoute(
      { ...BASE_CFG, jinaApiKey: "" },
      { query: "rappelle-moi ce qu'on a fait hier" },
    );
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_fallback");
    assert.equal(fetchCalled, false);
  });

  it("falls back to ALL when classifier returns an unknown route label", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [{ predictions: [{ label: "UNRECOGNIZED: invented by Jina", score: 1.0 }] }],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(BASE_CFG, {
      query: "rappelle-moi ce qu'on a fait hier",
    });
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_fallback");
  });
});
