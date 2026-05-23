// Unit tests for the router orchestrator.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { decideRoute } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/index.js";

const BASE_CFG: RouterConfig = {
  enabled: true,
  mode: "jina-classifier",
  jinaApiKey: "jina_test",
  // Default to a permissive threshold so the existing tests (which mock
  // confident classifier scores ≥ 0.8) keep validating the classifier_hit
  // path. The low-confidence guard is exercised explicitly by its own
  // describe block below.
  minConfidence: 0,
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

describe("decideRoute — low-confidence guard", () => {
  afterEach(() => mock.restoreAll());

  // The threshold used across this block matches the production default
  // (`DEFAULT_ROUTER_MIN_CONFIDENCE = 0.35`). Tests pin the boundary
  // semantics so a future tuning change is intentional and visible.
  const THRESHOLD = 0.35;

  it("falls back to ALL with classifier_low_confidence when score < minConfidence", async () => {
    // Regression scenario observed on jerome (2026-05-23):
    //   Query: "Quel est l'arbitrage principal de la réunion hebdomadaire
    //           Ataraxis du 19 mai 2026 ?"
    //   Classifier returned NONE @ 0.25 (noise floor — no real match),
    //   the router trusted it and silently blocked RAG retrieval.
    // With minConfidence=0.35 the router MUST fail open instead.
    const NOISE_SCORE = 0.25;
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "NONE: meta-question about the agent itself, session identifier, system test, simple greeting, weather, or trivial smalltalk that does not depend on the knowledge base",
                  score: NOISE_SCORE,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: THRESHOLD },
      {
        query:
          "Quel est l'arbitrage principal de la réunion hebdomadaire Ataraxis du 19 mai 2026 ?",
      },
    );
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_low_confidence");
    assert.equal(d.score, NOISE_SCORE);
  });

  it("keeps classifier_hit when score === minConfidence (>= passes)", async () => {
    // Exact-boundary score: the guard rejects only STRICTLY-lower scores.
    // Pinning the inclusive boundary keeps tuning predictable.
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "LIGHTRAG_ONLY: knowledge graph question about entities and their relationships — which client, which coach, which mission, which programme links to which livrable",
                  score: THRESHOLD,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: THRESHOLD },
      { query: "raconte-moi l'historique de la mission ABC" },
    );
    assert.equal(d.route, "LIGHTRAG_ONLY");
    assert.equal(d.reason, "classifier_hit");
    assert.equal(d.score, THRESHOLD);
  });

  it("keeps classifier_hit when score > minConfidence (clear match)", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "PGVECTOR_ONLY: factual lookup that can be answered by a single document excerpt — version numbers, file names, dates, configuration values, raw quotes",
                  score: 0.62,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: THRESHOLD },
      // Query deliberately ambiguous — avoids the heuristic keyword
      // fast-paths so the classifier path is actually exercised.
      { query: "rappelle-moi le contenu de ce paragraphe" },
    );
    assert.equal(d.route, "PGVECTOR_ONLY");
    assert.equal(d.reason, "classifier_hit");
    assert.equal(d.score, 0.62);
  });

  it("applies the guard to few-shot classifiers too", async () => {
    // A trained classifier can also return low-confidence predictions
    // (drift, distribution shift, etc.). The guard MUST apply uniformly
    // to both classifier paths.
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({ results: [{ label: "NONE", score: 0.20 }] }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: THRESHOLD, classifierId: "openclaw-router-v1" },
      // Query deliberately ambiguous — bypasses the heuristic keyword
      // short-circuits so the few-shot classifier path is exercised.
      { query: "rappelle-moi ce qu'on a fait hier" },
    );
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_low_confidence");
    assert.equal(d.score, 0.20);
  });

  it("applies DEFAULT_MIN_CONFIDENCE when minConfidence is omitted (public-API safety)", async () => {
    // Codex pass #25 P2: a JS caller using the public export and
    // omitting the new `minConfidence` field would previously bypass
    // the guard (because `score < undefined` is `false` in JS).
    // `decideRoute` now defaults to `DEFAULT_MIN_CONFIDENCE` at
    // function entry so the guard kicks in regardless.
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "NONE: meta-question about the agent itself, session identifier, system test, simple greeting, weather, or trivial smalltalk that does not depend on the knowledge base",
                  score: 0.25, // production noise-floor score
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    // Spread BASE_CFG MINUS minConfidence to simulate the legacy caller.
    const { minConfidence: _omitted, ...legacyCfg } = BASE_CFG;
    void _omitted;
    const d = await decideRoute(
      legacyCfg as RouterConfig,
      { query: "rappelle-moi ce qu'on a fait hier" },
    );
    assert.equal(d.route, "ALL");
    assert.equal(d.reason, "classifier_low_confidence");
    assert.equal(d.score, 0.25);
  });

  it("clamps a misconfigured negative minConfidence into [0, 1] (defense-in-depth)", async () => {
    // A negative threshold would make every score >= threshold, defeating
    // the guard. The function clamps the value at entry so the guard
    // semantics stay sane even when the config schema is bypassed.
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "PGVECTOR_ONLY: factual lookup that can be answered by a single document excerpt — version numbers, file names, dates, configuration values, raw quotes",
                  score: 0.5,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: -1 },
      { query: "rappelle-moi le contenu de ce paragraphe" },
    );
    // Clamped to 0 → every positive score passes the guard.
    assert.equal(d.route, "PGVECTOR_ONLY");
    assert.equal(d.reason, "classifier_hit");
  });

  it("with minConfidence=0 acts on every confident-or-not prediction (legacy behavior)", async () => {
    // Pin the escape hatch: setting minConfidence=0 disables the guard
    // and reproduces the pre-3.2.2 behavior. Useful for evaluation runs.
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              predictions: [
                {
                  label:
                    "NONE: meta-question about the agent itself, session identifier, system test, simple greeting, weather, or trivial smalltalk that does not depend on the knowledge base",
                  score: 0.001,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const d = await decideRoute(
      { ...BASE_CFG, minConfidence: 0 },
      { query: "ambiguous query" },
    );
    assert.equal(d.route, "NONE");
    assert.equal(d.reason, "classifier_hit");
    assert.equal(d.score, 0.001);
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
