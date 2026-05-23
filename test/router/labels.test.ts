// Unit tests for the router labels module.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROUTER_LABELS,
  ROUTER_LABEL_NAMES,
  ROUTE_ALL,
  ROUTE_LIGHTRAG_ONLY,
  ROUTE_NONE,
  ROUTE_PGVECTOR_ONLY,
  extractRouteFromLabel,
} from "../../src/router/labels.js";

describe("DEFAULT_ROUTER_LABELS", () => {
  it("contains exactly 4 labels, one per route", () => {
    assert.equal(DEFAULT_ROUTER_LABELS.length, 4);
  });

  it("each label starts with the canonical route name and a colon", () => {
    for (const label of DEFAULT_ROUTER_LABELS) {
      const route = extractRouteFromLabel(label);
      assert.ok(route, `label is missing a route prefix: ${label.slice(0, 40)}`);
      assert.ok(
        ROUTER_LABEL_NAMES.includes(route!),
        `label uses non-canonical route name: ${route}`,
      );
    }
  });

  it("covers all four canonical route names", () => {
    const extracted = DEFAULT_ROUTER_LABELS
      .map(extractRouteFromLabel)
      .filter((r): r is string => r !== null);
    assert.deepEqual(
      [...extracted].sort(),
      [ROUTE_ALL, ROUTE_LIGHTRAG_ONLY, ROUTE_NONE, ROUTE_PGVECTOR_ONLY].sort(),
    );
  });

  it("uses the canonical 'NONE' name (matches Route type, not 'NO_RETRIEVAL')", () => {
    // Regression: label names MUST match Route literals so isKnownRoute()
    // accepts the classifier prediction. A divergence would silently route
    // every no-retrieval prediction to ALL.
    assert.equal(ROUTE_NONE, "NONE");
    assert.ok(DEFAULT_ROUTER_LABELS[0]!.startsWith("NONE:"));
  });
});

describe("extractRouteFromLabel", () => {
  it("returns the prefix before the colon", () => {
    assert.equal(extractRouteFromLabel("NONE: meta question"), "NONE");
    assert.equal(extractRouteFromLabel("ALL: broad synthesis"), "ALL");
  });

  it("trims whitespace around the prefix", () => {
    assert.equal(extractRouteFromLabel("  HYBRID  : foo"), "HYBRID");
  });

  it("returns null when no colon is present", () => {
    assert.equal(extractRouteFromLabel("no colon here"), null);
  });

  it("returns null when the prefix is empty", () => {
    assert.equal(extractRouteFromLabel(":nothing before"), null);
  });
});
