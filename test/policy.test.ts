// Unit tests for the 4.0 policy model: named sources, agent defaults,
// session / one-shot overrides and their security invariant.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import {
  PolicyValidationError,
  applyOneShotConsumption,
  applyPolicyPatch,
  parseKnowledgeCommand,
  projectSessionState,
  resolveEffectivePolicy,
  sanitizeSessionState,
} from "../src/policy.js";

function multiSourceConfig(extra: Record<string, unknown> = {}) {
  return resolveConfig({
    geminiApiKey: "g",
    lightragApiKey: "legacy-key",
    sources: {
      graph: { type: "lightrag", label: "Graph", url: "http://lr-a:9621" },
      docs: { type: "pgvector", label: "Docs", collections: ["knowledge_jerome"] },
      shared: { type: "lightrag", label: "Shared", url: "http://lr-shared:9621" },
    },
    defaults: { sources: ["graph"], allowedSources: ["graph", "docs"] },
    agents: {
      jerome: { injection: "auto", sources: ["graph", "docs"], allowedSources: ["graph", "docs", "shared"] },
      files: { injection: "tool", sources: ["docs"] },
      locked: { sources: ["graph"], allowSessionOverrides: false },
    },
    ...extra,
  });
}

describe("config — named sources", () => {
  it("synthesizes legacy ids from the flat keys", () => {
    const cfg = resolveConfig({
      geminiApiKey: "g",
      collections: ["knowledge_jerome"],
      lightragUrl: "http://lr:9621",
      lightragApiKey: "k",
    });
    assert.deepEqual(
      cfg.sources.map((s) => [s.id, s.type, s.enabled, s.legacy]),
      [
        ["pgvector", "pgvector", true, true],
        ["lightrag", "lightrag", true, true],
      ],
    );
    assert.deepEqual(cfg.defaultPolicy.sources, ["pgvector", "lightrag"]);
    assert.equal(cfg.defaultPolicy.injection, "auto");
  });

  it("does not advertise pgvector when pgvectorEnabled=false (olivier)", () => {
    const cfg = resolveConfig({
      geminiApiKey: "g",
      pgvectorEnabled: false,
      lightragUrl: "http://lr:9621",
    });
    assert.deepEqual(cfg.sources.map((s) => s.id), ["lightrag"]);
    assert.equal(cfg.pgvectorEnabled, false);
    assert.equal(cfg.lightragEnabled, true);
  });

  it("resolves the registry with legacy fallbacks (apiKey, collections)", () => {
    const cfg = multiSourceConfig();
    const graph = cfg.sources.find((s) => s.id === "graph")!;
    assert.equal(graph.apiKey, "legacy-key");
    assert.equal(graph.legacy, false);
    assert.deepEqual(cfg.sources.find((s) => s.id === "docs")!.collections, ["knowledge_jerome"]);
    assert.equal(cfg.pgvectorEnabled, true);
    assert.equal(cfg.lightragEnabled, true);
  });

  it("warns on unknown source ids in agent policies and drops them", () => {
    const cfg = multiSourceConfig({
      agents: { x: { sources: ["graph", "nope"] } },
    });
    assert.deepEqual(cfg.agentPolicies.x!.sources, ["graph"]);
    assert.ok(cfg.configWarnings.some((w) => w.includes('"nope"')));
  });

  it("rejects invalid source entries", () => {
    const cfg = resolveConfig({
      sources: { "bad id!": { type: "lightrag", url: "http://x" }, ok: { type: "weird" } as never },
    });
    assert.equal(cfg.sources.length, 0);
    assert.equal(cfg.configWarnings.length, 2);
  });
});

describe("resolveEffectivePolicy — precedence", () => {
  const cfg = multiSourceConfig();

  it("falls back to the global default for an unknown agent", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg, agentId: "someone", sessionState: undefined, now: 0, consumeOneShot: true,
    });
    assert.equal(policy.injection, "auto");
    assert.deepEqual(policy.sources, ["graph"]);
    assert.deepEqual(policy.origin, { injection: "default", sources: "default" });
  });

  it("uses the agent default", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg, agentId: "files", sessionState: undefined, now: 0, consumeOneShot: true,
    });
    assert.equal(policy.injection, "tool");
    assert.deepEqual(policy.sources, ["docs"]);
    assert.equal(policy.origin.injection, "agent");
  });

  it("session override beats the agent default", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { injection: "hybrid", sources: ["shared"] },
      now: 0,
      consumeOneShot: true,
    });
    assert.equal(policy.injection, "hybrid");
    assert.deepEqual(policy.sources, ["shared"]);
    assert.deepEqual(policy.origin, { injection: "session", sources: "session" });
  });

  it("one-shot beats the session override, forces, and is consumed", () => {
    const res = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { injection: "off", oneShot: { injection: "auto", sources: ["docs"], setAt: 1_000 } },
      now: 2_000,
      runId: "run-1",
      consumeOneShot: true,
    });
    assert.equal(res.policy.injection, "auto");
    assert.deepEqual(res.policy.sources, ["docs"]);
    assert.equal(res.policy.force, true);
    assert.equal(res.policy.origin.injection, "oneShot");
    // Consumed: the session override stays, the one-shot is gone, the replay
    // guard remembers the run.
    assert.equal(res.nextState?.injection, "off");
    assert.equal(res.nextState?.oneShot, undefined);
    assert.equal(res.nextState?.lastOneShot?.runId, "run-1");
  });

  it("replays the consumed one-shot for a retry of the same run only", () => {
    const state = { injection: "off" as const, lastOneShot: { injection: "auto" as const, sources: ["docs"], runId: "run-1" } };
    const same = resolveEffectivePolicy({ config: cfg, agentId: "jerome", sessionState: state, now: 0, runId: "run-1", consumeOneShot: true });
    assert.equal(same.policy.injection, "auto");
    const next = resolveEffectivePolicy({ config: cfg, agentId: "jerome", sessionState: state, now: 0, runId: "run-2", consumeOneShot: true });
    assert.equal(next.policy.injection, "off");
  });

  it("decrements multi-turn one-shots", () => {
    const res = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: { sources: ["docs"], expiresAfterTurns: 3, setAt: 0 } },
      now: 10,
      consumeOneShot: true,
    });
    assert.equal(res.nextState?.oneShot?.expiresAfterTurns, 2);
  });

  it("ignores and clears an expired one-shot", () => {
    const res = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: { sources: ["docs"], setAt: 0 } },
      now: cfg.controlPlane.oneShotTtlMs + 1,
      consumeOneShot: true,
    });
    assert.deepEqual(res.policy.sources, ["graph", "docs"]);
    assert.equal(res.policy.force, false);
    assert.equal(res.nextState?.oneShot, undefined);
  });

  it("does not consume a one-shot when consumeOneShot=false (tool / status)", () => {
    const res = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: { sources: ["docs"], setAt: 0 } },
      now: 1,
      consumeOneShot: false,
    });
    assert.equal(res.nextState, undefined);
    assert.deepEqual(res.policy.sources, ["graph", "docs"]);
  });
});

describe("resolveEffectivePolicy — security invariant", () => {
  const cfg = multiSourceConfig();

  it("drops session sources the agent is not allowed to reach", () => {
    // `files` may only use `docs` (allowedSources defaults to sources).
    const { policy } = resolveEffectivePolicy({
      config: cfg,
      agentId: "files",
      sessionState: { sources: ["graph", "shared", "docs"] },
      now: 0,
      consumeOneShot: true,
    });
    assert.deepEqual(policy.sources, ["docs"]);
    assert.ok(policy.warnings.length > 0);
  });

  it("an entirely disallowed selection falls through to the agent default", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg,
      agentId: "files",
      sessionState: { sources: ["shared"], oneShot: { sources: ["graph"], setAt: 0 } },
      now: 1,
      consumeOneShot: true,
    });
    assert.deepEqual(policy.sources, ["docs"]);
    assert.equal(policy.origin.sources, "agent");
  });

  it("ignores unknown / malformed stored JSON", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { injection: "everything", sources: "graph", oneShot: [1, 2] },
      now: 0,
      consumeOneShot: true,
    });
    assert.equal(policy.injection, "auto");
    assert.deepEqual(policy.sources, ["graph", "docs"]);
  });

  it("ignores every override when allowSessionOverrides=false", () => {
    const { policy } = resolveEffectivePolicy({
      config: cfg,
      agentId: "locked",
      sessionState: { injection: "off", oneShot: { injection: "off", setAt: 0 } },
      now: 1,
      consumeOneShot: true,
    });
    assert.equal(policy.injection, "auto");
    assert.equal(policy.overridesAllowed, false);
  });
});

describe("applyPolicyPatch — strict write validation", () => {
  const cfg = multiSourceConfig();

  it("accepts a valid selection and stamps metadata", () => {
    const next = applyPolicyPatch({}, { injection: "tool", sources: ["shared"] }, cfg, "jerome", 42, "test");
    assert.equal(next.injection, "tool");
    assert.deepEqual(next.sources, ["shared"]);
    assert.equal(next.updatedAt, 42);
    assert.equal(next.updatedBy, "test");
  });

  it("rejects unknown source ids", () => {
    assert.throws(
      () => applyPolicyPatch({}, { sources: ["nope"] }, cfg, "jerome", 0, "t"),
      (err: unknown) => err instanceof PolicyValidationError && err.code === "unknown_source",
    );
  });

  it("rejects sources outside the agent allowlist", () => {
    assert.throws(
      () => applyPolicyPatch({}, { oneShot: { sources: ["shared"] } }, cfg, "files", 0, "t"),
      (err: unknown) => err instanceof PolicyValidationError && err.code === "source_not_allowed",
    );
  });

  it("rejects unknown fields and bad enum values", () => {
    assert.throws(() => applyPolicyPatch({}, { foo: 1 }, cfg, "jerome", 0, "t"), PolicyValidationError);
    assert.throws(() => applyPolicyPatch({}, { injection: "loud" }, cfg, "jerome", 0, "t"), PolicyValidationError);
    assert.throws(
      () => applyPolicyPatch({}, { oneShot: { expiresAfterTurns: 99, sources: ["docs"] } }, cfg, "jerome", 0, "t"),
      PolicyValidationError,
    );
  });

  it("refuses writes when overrides are disabled", () => {
    assert.throws(
      () => applyPolicyPatch({}, { injection: "off" }, cfg, "locked", 0, "t"),
      (err: unknown) => err instanceof PolicyValidationError && err.code === "overrides_disabled",
    );
  });

  it("null clears a field; reset clears everything", () => {
    const base = applyPolicyPatch({}, { injection: "off", sources: ["docs"] }, cfg, "jerome", 1, "t");
    const cleared = applyPolicyPatch(base, { sources: null }, cfg, "jerome", 2, "t");
    assert.equal(cleared.injection, "off");
    assert.equal(cleared.sources, undefined);
    const reset = applyPolicyPatch(base, { reset: true }, cfg, "jerome", 3, "t");
    assert.equal(reset.injection, undefined);
  });

  it("stamps setAt on one-shots", () => {
    const next = applyPolicyPatch({}, { oneShot: { sources: ["docs"] } }, cfg, "jerome", 777, "t");
    assert.equal(next.oneShot?.setAt, 777);
  });
});

describe("session state projection", () => {
  it("never projects the internal replay guard", () => {
    const state = sanitizeSessionState({
      injection: "auto",
      lastOneShot: { sources: ["a"], runId: "r" },
      junk: true,
    });
    assert.equal(state.lastOneShot?.runId, "r");
    const projected = projectSessionState(state);
    assert.equal("lastOneShot" in projected, false);
    assert.equal("junk" in projected, false);
    assert.equal(projected.v, 1);
  });
});

describe("parseKnowledgeCommand", () => {
  it("parses every subcommand", () => {
    assert.deepEqual(parseKnowledgeCommand(""), { kind: "status" });
    assert.deepEqual(parseKnowledgeCommand("status"), { kind: "status" });
    assert.deepEqual(parseKnowledgeCommand("on"), { kind: "set", patch: { injection: "auto" } });
    assert.deepEqual(parseKnowledgeCommand("OFF"), { kind: "set", patch: { injection: "off" } });
    assert.deepEqual(parseKnowledgeCommand("tool"), { kind: "set", patch: { injection: "tool" } });
    assert.deepEqual(parseKnowledgeCommand("hybrid"), { kind: "set", patch: { injection: "hybrid" } });
    assert.deepEqual(parseKnowledgeCommand("use graph, docs"), {
      kind: "set",
      patch: { sources: ["graph", "docs"] },
    });
    assert.deepEqual(parseKnowledgeCommand("use all"), { kind: "set", patch: { sources: null } });
    assert.deepEqual(parseKnowledgeCommand("once docs"), {
      kind: "set",
      patch: { oneShot: { injection: "auto", sources: ["docs"] } },
    });
    assert.deepEqual(parseKnowledgeCommand("reset"), { kind: "reset" });
    assert.equal(parseKnowledgeCommand("use").kind, "error");
    assert.equal(parseKnowledgeCommand("explode").kind, "error");
  });
});

describe("one-shot consumption — concurrency and replay", () => {
  const cfg = multiSourceConfig();
  const shot = { sources: ["docs"], expiresAfterTurns: 2, setAt: 1_000 };

  it("a retry of the same run neither re-consumes nor loses a multi-turn one-shot", () => {
    // State after the first attempt of run-1 consumed one of two turns.
    const state = {
      oneShot: { ...shot, expiresAfterTurns: 1 },
      lastOneShot: { sources: ["docs"], runId: "run-1" },
    };
    const retry = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: state,
      now: 2_000,
      runId: "run-1",
      consumeOneShot: true,
    });
    assert.deepEqual(retry.policy.sources, ["docs"]);
    assert.equal(retry.consumption, undefined);
    // The next human run still gets the remaining turn.
    const next = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: state,
      now: 2_000,
      runId: "run-2",
      consumeOneShot: true,
    });
    assert.deepEqual(next.policy.sources, ["docs"]);
    assert.equal(next.nextState?.oneShot, undefined);
  });

  it("never applies an undated one-shot (raw sessions.pluginPatch write)", () => {
    const res = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: { sources: ["docs"] } },
      now: 5,
      consumeOneShot: true,
    });
    assert.deepEqual(res.policy.sources, ["graph", "docs"]);
    assert.equal(res.policy.force, false);
    assert.equal(res.consumption?.expired, true);
    assert.equal(res.nextState?.oneShot, undefined);
  });

  it("keeps a session override written after the turn read the row", () => {
    const { consumption } = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: shot },
      now: 2_000,
      runId: "run-1",
      consumeOneShot: true,
    });
    const fresh = { oneShot: shot, injection: "off", updatedAt: 1_500 };
    const next = applyOneShotConsumption(fresh, consumption!);
    assert.equal(next?.injection, "off");
    assert.equal(next?.oneShot?.expiresAfterTurns, 1);
    assert.equal(next?.lastOneShot?.runId, "run-1");
  });

  it("is a no-op when the one-shot was replaced or already consumed", () => {
    const { consumption } = resolveEffectivePolicy({
      config: cfg,
      agentId: "jerome",
      sessionState: { oneShot: shot },
      now: 2_000,
      runId: "run-1",
      consumeOneShot: true,
    });
    const replaced = { oneShot: { sources: ["graph"], setAt: 1_900 } };
    assert.equal(applyOneShotConsumption(replaced, consumption!), undefined);
    const consumed = { oneShot: { ...shot, expiresAfterTurns: 1 }, lastOneShot: { sources: ["docs"], runId: "run-1" } };
    assert.equal(applyOneShotConsumption(consumed, consumption!), undefined);
    assert.equal(applyOneShotConsumption({}, consumption!), undefined);
  });
});
