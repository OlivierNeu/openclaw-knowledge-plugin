// Unit tests for the structured event emitter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_PREFIX,
  emitEvent,
  emitTurnMetadata,
} from "../../src/tracing/events.js";
import type {
  CooldownEvent,
  JinaRpmExceededEvent,
  JinaUsageEvent,
  KnowledgeEvent,
  LightRAGEvent,
  PgvectorEvent,
  RouterEvent,
  TracingLogger,
} from "../../src/tracing/events.js";

interface RecordingLogger extends TracingLogger {
  infos: string[];
  debugs: string[];
}

function makeLogger(): RecordingLogger {
  const infos: string[] = [];
  const debugs: string[] = [];
  return {
    infos,
    debugs,
    info: (msg) => infos.push(msg),
    debug: (msg) => debugs.push(msg),
  };
}

describe("emitEvent", () => {
  it("emits a router event with the canonical prefix and JSON payload", () => {
    const logger = makeLogger();
    const evt: RouterEvent = {
      type: "router",
      route: "PGVECTOR_ONLY",
      reason: "heuristic_keyword",
      score: null,
      queryLength: 42,
      trigger: "user",
    };
    emitEvent(logger, evt);

    assert.equal(logger.infos.length, 1);
    assert.ok(logger.infos[0]!.startsWith(`${EVENT_PREFIX} `));
    const parsed = JSON.parse(logger.infos[0]!.slice(EVENT_PREFIX.length + 1));
    assert.deepEqual(parsed, evt);
  });

  it("supports all event shapes", () => {
    const logger = makeLogger();
    const events: KnowledgeEvent[] = [
      {
        type: "pgvector",
        collections: ["a", "b"],
        rawCount: 10,
        rerankedCount: 5,
        topScore: 0.92,
        durationMs: 250,
        errored: false,
      } satisfies PgvectorEvent,
      {
        type: "lightrag",
        mode: "hybrid",
        contextChars: 1200,
        truncatedChars: 1000,
        durationMs: 500,
        sparse: false,
      } satisfies LightRAGEvent,
      {
        type: "jina",
        endpoint: "rerank",
        model: "jina-reranker-v2-base-multilingual",
        durationMs: 80,
        inputCount: 20,
      } satisfies JinaUsageEvent,
      {
        type: "cooldown",
        scope: "router",
        consecutiveErrors: 3,
      } satisfies CooldownEvent,
      {
        type: "jina_rpm_exceeded",
        count: 72,
        budget: 60,
      } satisfies JinaRpmExceededEvent,
    ];

    for (const evt of events) {
      emitEvent(logger, evt);
    }

    assert.equal(logger.infos.length, events.length);
  });

  it("never throws when the logger crashes", () => {
    const crashingLogger: TracingLogger = {
      info: () => {
        throw new Error("logger broken");
      },
    };

    // Must not throw — tracing failures are silent.
    emitEvent(crashingLogger, {
      type: "router",
      route: "NONE",
      reason: "heuristic_trigger",
      score: null,
      queryLength: 0,
    });
  });
});

describe("emitTurnMetadata (privacy-safe correlation via SDK runId)", () => {
  it("emits a debug line with the SDK runId and query length", () => {
    const logger = makeLogger();
    emitTurnMetadata(logger, "run-abc-123", 42);
    assert.equal(logger.debugs.length, 1);
    const line = logger.debugs[0]!;
    assert.ok(line.startsWith(`${EVENT_PREFIX} turn.metadata `));
    assert.match(line, / runId=run-abc-123 /);
    assert.match(line, / qlen=42$/);
  });

  it("substitutes 'unknown' when runId is missing", () => {
    const logger = makeLogger();
    emitTurnMetadata(logger, undefined, 7);
    assert.match(logger.debugs[0]!, /runId=unknown/);
  });

  it("substitutes 'unknown' when runId is an empty string", () => {
    const logger = makeLogger();
    emitTurnMetadata(logger, "", 7);
    assert.match(logger.debugs[0]!, /runId=unknown/);
  });

  it("NEVER includes any portion of the query, nor any hash of it (privacy invariant)", () => {
    // Codex pass #6 (2026-05-23) flagged the prior `SHA-256(query)` hash
    // as dictionary-recoverable on short prompts. The fix removed the
    // hash entirely. This test pins the contract: no query content AND
    // no hex string longer than the runId itself.
    const logger = makeLogger();
    const query = "patient John Doe has condition X and takes medication Y";
    emitTurnMetadata(logger, "run-xyz", query.length);
    const line = logger.debugs[0]!;
    for (const word of query.split(/\s+/)) {
      assert.ok(!line.includes(word), `query word "${word}" leaked: ${line}`);
    }
    // No raw hex blob that could be a hash of the query.
    assert.ok(
      !/\b[0-9a-f]{12,}\b/.test(line.replace("run-xyz", "")),
      `suspicious long hex token leaked into log: ${line}`,
    );
  });

  it("does nothing when logger.debug is absent", () => {
    const logger: TracingLogger = { info: () => {} };
    // Must not throw.
    emitTurnMetadata(logger, "run-1", 5);
  });
});
