// Unit tests for the zero-cost router heuristics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { heuristicRoute, NON_USER_TRIGGERS } from "../../src/router/heuristic.js";

describe("heuristicRoute — trigger gating", () => {
  it("returns NONE on heartbeat trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "heartbeat" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("returns NONE on cron trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "cron" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("returns NONE on memory trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "memory" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("does NOT skip on user trigger", () => {
    const v = heuristicRoute({ query: "what is in my drive?", trigger: "user" });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip when trigger is undefined", () => {
    const v = heuristicRoute({ query: "what is in my drive?" });
    assert.notEqual(v.route, "NONE");
  });

  it("NON_USER_TRIGGERS contains exactly the three documented values", () => {
    assert.deepEqual(
      [...NON_USER_TRIGGERS].sort(),
      ["cron", "heartbeat", "memory"],
    );
  });
});

describe("heuristicRoute — meta-agent regex", () => {
  it("skips 'quel est ton identifiant de session'", () => {
    const v = heuristicRoute({ query: "Quel est ton identifiant de session ?" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });

  it("skips 'session id'", () => {
    const v = heuristicRoute({ query: "what is your session id?" });
    assert.equal(v.route, "NONE");
  });

  it("skips 'combien d'agents'", () => {
    const v = heuristicRoute({ query: "combien d'agent et subagent dans cette instance" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });

  it("skips 'who are you'", () => {
    assert.equal(heuristicRoute({ query: "who are you?" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "qui es-tu" }).route, "NONE");
  });

  it("does NOT skip a legitimate question that mentions 'session' in a business sense", () => {
    const v = heuristicRoute({
      query: "résume les notes de la session du 28 mai avec Maurice",
    });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip business questions ending with 'status' (Codex review regression)", () => {
    // The "status" trigger MUST be anchored to the whole-prompt; otherwise
    // every project / mission / ticket status question gets dropped.
    const queries = [
      "what is the ACME project status?",
      "quel est le statut de la mission Saint-Gratien ?",
      "donne-moi le status du programme 2026",
      "is the deployment status ok",
    ];
    for (const q of queries) {
      const v = heuristicRoute({ query: q });
      assert.notEqual(v.route, "NONE", `"${q}" was incorrectly classified as meta`);
    }
  });

  it("DOES skip a bare 'status?' system ping", () => {
    assert.equal(heuristicRoute({ query: "status?" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "status" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "system status" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "the system status?" }).route, "NONE");
  });
});

describe("heuristicRoute — CLI trivial pings", () => {
  it("skips 'test de bon fonctionnement' from cli", () => {
    const v = heuristicRoute({
      query: "Test de bon fonctionnement",
      isCli: true,
    });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_short");
  });

  it("skips 'ping' from cli", () => {
    assert.equal(heuristicRoute({ query: "ping", isCli: true }).route, "NONE");
    assert.equal(heuristicRoute({ query: "hello", isCli: true }).route, "NONE");
    assert.equal(heuristicRoute({ query: "salut", isCli: true }).route, "NONE");
  });

  it("does NOT skip the same prompt when not from cli", () => {
    // A real collaborator typing 'test' should still go through the
    // classifier, not be silently dropped.
    const v = heuristicRoute({ query: "test", isCli: false });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip a long prompt from cli", () => {
    const v = heuristicRoute({
      query: "compare the changelog of v3.1.0 and v3.2.0",
      isCli: true,
    });
    assert.notEqual(v.route, "NONE");
  });
});

describe("heuristicRoute — keyword fast-paths", () => {
  it("routes to PGVECTOR_ONLY on 'version'", () => {
    const v = heuristicRoute({ query: "quelle est la version d'OpenClaw de Jerome ?" });
    assert.equal(v.route, "PGVECTOR_ONLY");
    assert.equal(v.reason, "heuristic_keyword");
  });

  it("routes to PGVECTOR_ONLY on a file name with extension", () => {
    const v = heuristicRoute({
      query: "ouvre HANDOFF-TRAEFIK-MIGRATION-2026-05-11.md",
    });
    assert.equal(v.route, "PGVECTOR_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'compare'", () => {
    const v = heuristicRoute({
      query: "compare les méthodes pédagogiques de 2024 et 2026",
    });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'audit'", () => {
    const v = heuristicRoute({ query: "fait un audit complet de la stack" });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'synthèse'", () => {
    const v = heuristicRoute({
      query: "synthèse des feedbacks coach sur la mission",
    });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("returns null route when nothing matches", () => {
    const v = heuristicRoute({
      query: "rappelle-moi ce qu'on a discuté hier",
    });
    assert.equal(v.route, null);
    assert.equal(v.reason, "classifier_fallback");
  });
});

describe("heuristicRoute — priority ordering", () => {
  it("trigger gating beats meta-agent regex", () => {
    const v = heuristicRoute({
      query: "session id?",
      trigger: "heartbeat",
    });
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("meta-agent beats CLI-trivial when both would match", () => {
    // 'ping' matches BOTH the meta-agent regex (status / ping question)
    // AND the CLI-trivial pattern. Rule order in `heuristicRoute` is:
    //   1. trigger gating
    //   2. meta-agent regex   <-- fires here
    //   3. CLI-trivial
    // so the reason must be `heuristic_meta` (deterministic, documented).
    const v = heuristicRoute({ query: "ping", isCli: true });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });
});
