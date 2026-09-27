// Unit tests for the per-session result cache and local keyword extraction.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  KnowledgeResultCache,
  normalizeQueryForCache,
  sessionScopeKey,
} from "../src/cache.js";
import { extractKeywords } from "../src/keywords.js";

describe("KnowledgeResultCache", () => {
  it("returns stored values until the TTL elapses", () => {
    let now = 1_000;
    const cache = new KnowledgeResultCache<string>({
      ttlMs: 100,
      maxEntries: 10,
      maxBytes: 10_000,
      now: () => now,
    });
    cache.set("k", "v", "s1");
    assert.equal(cache.get("k"), "v");
    now += 101;
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.size, 0);
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = new KnowledgeResultCache<string>({ ttlMs: 10_000, maxEntries: 2, maxBytes: 10_000 });
    cache.set("a", "1", "s");
    cache.set("b", "2", "s");
    cache.get("a"); // a is now most recent
    cache.set("c", "3", "s");
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.get("c"), "3");
  });

  it("enforces maxBytes and refuses single oversized entries", () => {
    const cache = new KnowledgeResultCache<string>({ ttlMs: 10_000, maxEntries: 100, maxBytes: 100 });
    cache.set("big", "x".repeat(200), "s");
    assert.equal(cache.get("big"), undefined);
    cache.set("a", "x".repeat(20), "s"); // ~44 bytes
    cache.set("b", "x".repeat(20), "s");
    cache.set("c", "x".repeat(20), "s"); // exceeds 100 → evict oldest
    assert.ok(cache.bytes <= 100);
    assert.equal(cache.get("a"), undefined);
  });

  it("purges one session without touching others", () => {
    const cache = new KnowledgeResultCache<string>({ ttlMs: 10_000, maxEntries: 10, maxBytes: 10_000 });
    const s1 = sessionScopeKey("olivier", "agent:olivier:main");
    const s2 = sessionScopeKey("olivier", "agent:olivier:other");
    cache.set("a", "1", s1);
    cache.set("b", "2", s2);
    assert.equal(cache.purgeSessionKey("agent:olivier:main"), 1);
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "2");
  });

  it("is disabled with maxEntries=0", () => {
    const cache = new KnowledgeResultCache<string>({ ttlMs: 10_000, maxEntries: 0, maxBytes: 10_000 });
    cache.set("a", "1", "s");
    assert.equal(cache.get("a"), undefined);
  });

  it("normalizes queries (case, whitespace, trailing punctuation)", () => {
    assert.equal(normalizeQueryForCache("  Projet   Hélios ?! "), "projet hélios");
    assert.equal(normalizeQueryForCache("PROJET HÉLIOS"), normalizeQueryForCache("projet hélios"));
  });
});

describe("extractKeywords", () => {
  it("keeps proper-noun sequences and content words, drops FR stopwords", () => {
    const kw = extractKeywords("Quel est le statut du Projet Hélios chez ACME ?");
    assert.ok(kw.ll.includes("Projet Hélios"));
    assert.ok(kw.ll.includes("ACME"));
    assert.ok(!kw.ll.map((w) => w.toLowerCase()).includes("quel"));
    assert.ok(!kw.ll.map((w) => w.toLowerCase()).includes("est"));
    assert.ok(kw.hl.length > 0);
  });

  it("builds high-level phrases from consecutive content words (EN)", () => {
    const kw = extractKeywords("What are the relations between the CRM migration and the audit report?");
    assert.ok(kw.hl.includes("crm migration"));
    assert.ok(kw.hl.includes("audit report"));
    assert.ok(!kw.ll.includes("the"));
  });

  it("returns empty lists for a pure stopword / ack message", () => {
    assert.deepEqual(extractKeywords("merci"), { hl: [], ll: [] });
    assert.deepEqual(extractKeywords("est-ce que tu peux"), { hl: [], ll: [] });
  });

  it("respects LightRAG bounds", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Terme${i}`).join(" ");
    const kw = extractKeywords(long);
    assert.ok(kw.ll.length <= 64 && kw.hl.length <= 64);
    for (const k of [...kw.ll, ...kw.hl]) assert.ok(k.length <= 512);
  });
});
