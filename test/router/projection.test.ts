// Regression tests for `projectRouteOnEnabledSources`.
//
// Codex review (2026-05-23) flagged that an exclusive router decision
// pointing to a disabled source resulted in `tasks=[]` and silent
// retrieval drop. The projection function fixes the gap by falling back
// to whatever IS enabled.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { projectRouteOnEnabledSources } from "../../src/index.js";

describe("projectRouteOnEnabledSources", () => {
  // NONE / ALL are pass-through
  it("passes NONE through regardless of available sources", () => {
    assert.equal(projectRouteOnEnabledSources("NONE", true, true), "NONE");
    assert.equal(projectRouteOnEnabledSources("NONE", false, false), "NONE");
  });

  it("passes ALL through regardless of available sources", () => {
    assert.equal(projectRouteOnEnabledSources("ALL", true, true), "ALL");
    assert.equal(projectRouteOnEnabledSources("ALL", true, false), "ALL");
    assert.equal(projectRouteOnEnabledSources("ALL", false, true), "ALL");
    assert.equal(projectRouteOnEnabledSources("ALL", false, false), "ALL");
    // The downstream task-builder skips disabled sources, so ALL→ALL
    // works as expected even with partial availability.
  });

  // Exclusive routes — preserved when the target source IS available
  it("preserves PGVECTOR_ONLY when pgvector is enabled", () => {
    assert.equal(projectRouteOnEnabledSources("PGVECTOR_ONLY", true, true), "PGVECTOR_ONLY");
    assert.equal(projectRouteOnEnabledSources("PGVECTOR_ONLY", true, false), "PGVECTOR_ONLY");
  });

  it("preserves LIGHTRAG_ONLY when LightRAG is enabled", () => {
    assert.equal(projectRouteOnEnabledSources("LIGHTRAG_ONLY", true, true), "LIGHTRAG_ONLY");
    assert.equal(projectRouteOnEnabledSources("LIGHTRAG_ONLY", false, true), "LIGHTRAG_ONLY");
  });

  // The critical regression cases
  it("falls back from PGVECTOR_ONLY to LIGHTRAG_ONLY when only LightRAG is enabled", () => {
    // Scenario: pgvector-only-disabled deployment, router says PGVECTOR_ONLY.
    // Before fix: empty tasks → silent retrieval drop.
    // After fix: best-effort fallback to LightRAG.
    assert.equal(
      projectRouteOnEnabledSources("PGVECTOR_ONLY", false, true),
      "LIGHTRAG_ONLY",
    );
  });

  it("falls back from LIGHTRAG_ONLY to PGVECTOR_ONLY when only pgvector is enabled", () => {
    // Mirror scenario: LightRAG-disabled deployment, router says LIGHTRAG_ONLY.
    // Codex's exact example: pgvector-only deployment + "compare..." query.
    assert.equal(
      projectRouteOnEnabledSources("LIGHTRAG_ONLY", true, false),
      "PGVECTOR_ONLY",
    );
  });

  it("falls back to NONE when an exclusive route targets a disabled source AND the alternate is also disabled", () => {
    assert.equal(projectRouteOnEnabledSources("PGVECTOR_ONLY", false, false), "NONE");
    assert.equal(projectRouteOnEnabledSources("LIGHTRAG_ONLY", false, false), "NONE");
  });
});
