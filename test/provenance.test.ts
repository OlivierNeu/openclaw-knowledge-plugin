// Provenance reporting (provenance/v1) — builders + emission guards.
// Contract: openclaw-webchat docs/PROVENANCE_CONTRACT.md. The webchat's C18
// live check pins the wire transport; THESE tests pin the plugin half: level
// gating (off/metadata/full), faithful item mapping, bounds, and the
// fail-silent emission guards.

import { strict as assert } from "node:assert";
import { describe, it, mock } from "node:test";

import {
  PROVENANCE_EXCERPT_MAX_CHARS,
  PROVENANCE_MAX_ITEMS,
  PROVENANCE_STREAM,
  buildLightRAGProvenance,
  buildPgvectorProvenance,
  emitProvenanceReports,
  resolveEmitAgentEvent,
  resolveProvenanceLevel,
} from "../src/provenance.js";
import { formatPgvectorResultsDetailed } from "../src/pgvector.js";
import type { PgvectorResult } from "../src/types.js";

const HIT: PgvectorResult = {
  collection: "knowledge_test",
  score: 0.93,
  file_name: "compliance-report.pdf",
  mime_type: "application/pdf",
  text: "Section 4.2 defines the retention policy.",
  file_id: "f_123",
  source: null,
  owner: null,
  chunk_index: 1,
  total_chunks: 10,
  timestamp_start: null,
  timestamp_end: null,
};

const fakeLogger = () => {
  const warnings: string[] = [];
  return {
    logger: {
      info: () => {},
      warn: (m: string) => warnings.push(m),
      error: () => {},
      debug: () => {},
    },
    warnings,
  };
};

describe("resolveProvenanceLevel", () => {
  it("accepts the three contract levels; anything else collapses to off", () => {
    assert.equal(resolveProvenanceLevel("off"), "off");
    assert.equal(resolveProvenanceLevel("metadata"), "metadata");
    assert.equal(resolveProvenanceLevel("full"), "full");
    assert.equal(resolveProvenanceLevel("FULL"), "off");
    assert.equal(resolveProvenanceLevel("everything"), "off");
    assert.equal(resolveProvenanceLevel(undefined), "off");
    assert.equal(resolveProvenanceLevel(42), "off");
  });
});

describe("buildPgvectorProvenance", () => {
  it("off level or empty data -> null (no report)", () => {
    assert.equal(buildPgvectorProvenance([HIT], ["c"], "off", 100), null);
    assert.equal(buildPgvectorProvenance([], ["c"], "full", 100), null);
  });

  it("metadata level: identifying fields WITHOUT text", () => {
    const report = buildPgvectorProvenance([HIT], ["knowledge_test"], "metadata", 500);
    assert.ok(report);
    assert.equal(report.v, 1);
    assert.equal(report.source, "knowledge");
    assert.equal(report.kind, "documents");
    assert.deepEqual(report.retrieval, {
      route: "pgvector",
      collections: ["knowledge_test"],
    });
    assert.deepEqual(report.items, [
      { collection: "knowledge_test", score: 0.93, file_name: "compliance-report.pdf" },
    ]);
    assert.equal(report.injected?.chars, 500);
  });

  it("full level: adds the exact injected excerpt, bounded", () => {
    const long = { ...HIT, text: "x".repeat(PROVENANCE_EXCERPT_MAX_CHARS + 999) };
    const report = buildPgvectorProvenance([long], ["c"], "full", 500);
    assert.equal(report?.items[0]?.text?.length, PROVENANCE_EXCERPT_MAX_CHARS);
  });

  it("falls back to file_id when file_name is absent; caps the item count", () => {
    const anon = { ...HIT, file_name: null };
    const report = buildPgvectorProvenance([anon], ["c"], "metadata", 1);
    assert.equal(report?.items[0]?.id, "f_123");
    assert.equal(report?.items[0]?.file_name, undefined);

    const many = Array.from({ length: 40 }, () => HIT);
    assert.equal(
      buildPgvectorProvenance(many, ["c"], "metadata", 1)?.items.length,
      PROVENANCE_MAX_ITEMS,
    );
  });
});

/**
 * End-to-end composition test that mirrors how `renderSection` in
 * `src/index.ts` wires `formatPgvectorResultsDetailed` to
 * `buildPgvectorProvenance`.
 *
 * Regression guard for the v3.2.5 P2 (codex pass): when `maxInjectChars`
 * truncates the post-rerank list, the provenance report MUST mirror ONLY
 * the entries actually injected into the prompt — never the dropped tail.
 *
 * Before the fix, `renderSection` passed the full `result.data` to
 * `buildPgvectorProvenance`, leaking metadata (and excerpts in `full` mode)
 * of documents the LLM never saw — breaking the contract rule "emit what
 * was injected, not what was retrieved".
 *
 * Public `formatPgvectorResults` (signature preserved at `string | null`)
 * is exercised in `test/pgvector.test.ts`; here we exercise the internal
 * Detailed variant that exposes `injectedCount`.
 */
describe("pgvector provenance composition (maxInjectChars truncation)", () => {
  // Each entry is ~250 chars once formatted (lines + content). With
  // maxChars = 600 only the first two contiguous entries fit; the last
  // three are dropped by the helper's `break`.
  const buildHits = (): PgvectorResult[] =>
    Array.from({ length: 5 }, (_, i) => ({
      collection: "knowledge_test",
      score: 0.9 - i * 0.05,
      file_name: `doc-${i}.pdf`,
      // Make each entry well under 250 chars so the budget bites at
      // exactly the third entry.
      text: `secret-text-${i}-${"x".repeat(200)}`,
      mime_type: "application/pdf",
      file_id: `f_${i}`,
      source: null,
      owner: null,
      chunk_index: 0,
      total_chunks: 1,
      timestamp_start: null,
      timestamp_end: null,
    }));

  it("truncated case: formatted contains only the entries that fit", () => {
    const hits = buildHits();
    const formatted = formatPgvectorResultsDetailed(hits, 600);
    assert.ok(formatted);
    // Sanity: only the first two entries fit in the 600-char budget.
    assert.equal(formatted!.injectedCount, 2);
    assert.ok(formatted!.output.includes("doc-0.pdf"));
    assert.ok(formatted!.output.includes("doc-1.pdf"));
    // The dropped entries (and their texts) MUST NOT appear in the
    // prompt-ready output.
    assert.ok(!formatted!.output.includes("doc-2.pdf"));
    assert.ok(!formatted!.output.includes("secret-text-2"));
    assert.ok(!formatted!.output.includes("secret-text-3"));
    assert.ok(!formatted!.output.includes("secret-text-4"));
  });

  it("truncated case: provenance metadata report mirrors only the injected subset", () => {
    const hits = buildHits();
    const formatted = formatPgvectorResultsDetailed(hits, 600);
    assert.ok(formatted);
    // Slice exactly as `src/index.ts` does — this is the contract.
    const injected = hits.slice(0, formatted!.injectedCount);
    const report = buildPgvectorProvenance(
      injected,
      ["knowledge_test"],
      "metadata",
      formatted!.output.length,
    );
    assert.ok(report);
    assert.equal(report.items.length, 2);
    assert.deepEqual(
      report.items.map((it) => it.file_name),
      ["doc-0.pdf", "doc-1.pdf"],
    );
    // Dropped file names MUST NOT appear in the report.
    const reportFileNames = report.items.map((it) => it.file_name);
    assert.ok(!reportFileNames.includes("doc-2.pdf"));
    assert.ok(!reportFileNames.includes("doc-3.pdf"));
    assert.ok(!reportFileNames.includes("doc-4.pdf"));
  });

  it("truncated case + full level: no excerpt from any dropped entry is leaked", () => {
    const hits = buildHits();
    const formatted = formatPgvectorResultsDetailed(hits, 600);
    assert.ok(formatted);
    const injected = hits.slice(0, formatted!.injectedCount);
    const report = buildPgvectorProvenance(
      injected,
      ["knowledge_test"],
      "full",
      formatted!.output.length,
    );
    assert.ok(report);
    assert.equal(report.items.length, 2);
    // Each kept item carries its text; dropped items must NOT be present.
    const allTexts = report.items.map((it) => it.text ?? "").join("\n");
    assert.ok(allTexts.includes("secret-text-0"));
    assert.ok(allTexts.includes("secret-text-1"));
    assert.ok(!allTexts.includes("secret-text-2"));
    assert.ok(!allTexts.includes("secret-text-3"));
    assert.ok(!allTexts.includes("secret-text-4"));
  });

  it("no truncation: injectedCount == data.length, all items reported", () => {
    const hits = buildHits();
    // A very large budget keeps every entry — pre-3.2.5 behavior is
    // preserved when the budget never bites.
    const formatted = formatPgvectorResultsDetailed(hits, 100_000);
    assert.ok(formatted);
    assert.equal(formatted!.injectedCount, hits.length);
    const injected = hits.slice(0, formatted!.injectedCount);
    const report = buildPgvectorProvenance(
      injected,
      ["knowledge_test"],
      "metadata",
      formatted!.output.length,
    );
    assert.equal(report?.items.length, hits.length);
  });
});

describe("buildLightRAGProvenance", () => {
  it("off level or empty context -> null", () => {
    assert.equal(buildLightRAGProvenance("ctx", "mix", "off"), null);
    assert.equal(buildLightRAGProvenance("", "mix", "full"), null);
  });

  it("metadata: one mode-typed item without text; full adds the excerpt", () => {
    const meta = buildLightRAGProvenance("the injected graph context", "mix", "metadata");
    assert.deepEqual(meta?.items, [
      { id: "lightrag-context", type: "mix", context: true },
    ]);
    assert.equal(meta?.injected?.chars, "the injected graph context".length);
    assert.deepEqual(meta?.retrieval, { route: "lightrag", lightrag: { mode: "mix" } });

    const full = buildLightRAGProvenance("the injected graph context", "mix", "full");
    assert.equal(full?.items[0]?.text, "the injected graph context");
  });

  it("injectedChars param overrides injected.chars but keeps excerpt body untouched (codex pass #36 P3)", () => {
    // Mirrors how `renderSection` wires the helper: the section actually
    // delivered to the LLM includes the `### Knowledge Graph Context …`
    // header on top of the body, so the caller passes the full section
    // length. The `full`-level excerpt must remain the BODY only — the
    // structural header is not useful content for the chat frontend.
    const body = "the injected graph context";
    const sectionLength = "### Knowledge Graph Context (LightRAG)\n".length + body.length;
    const report = buildLightRAGProvenance(body, "mix", "full", sectionLength);
    assert.equal(report?.injected?.chars, sectionLength);
    assert.equal(report?.items[0]?.text, body);
  });

  it("ignores invalid injectedChars (NaN, negative) and falls back to body length", () => {
    const body = "the injected graph context";
    assert.equal(buildLightRAGProvenance(body, "mix", "metadata", -1)?.injected?.chars, body.length);
    assert.equal(buildLightRAGProvenance(body, "mix", "metadata", Number.NaN)?.injected?.chars, body.length);
  });

  it("no references -> identical single opaque item (no regression)", () => {
    const report = buildLightRAGProvenance("ctx", "mix", "metadata", undefined, []);
    assert.deepEqual(report?.items, [
      { id: "lightrag-context", type: "mix", context: true },
    ]);
  });

  it("metadata: emits one file_name item per reference + the context item last", () => {
    const report = buildLightRAGProvenance("ctx", "hybrid", "metadata", undefined, [
      { file_path: "a.md", reference_id: "1" },
      { file_path: "b.md" },
    ]);
    // reference_id is intentionally NOT surfaced (PROVENANCE_CONTRACT §3:
    // documents are keyed by file_name; reference_id is a per-query ordinal).
    assert.deepEqual(report?.items, [
      { file_name: "a.md", type: "hybrid" },
      { file_name: "b.md", type: "hybrid" },
      { id: "lightrag-context", type: "hybrid", context: true },
    ]);
  });

  it("full: a reference's RETRIEVED content becomes its item.text + score (3.2.12)", () => {
    // The user must see the source material the RAG pulled per document. A reference's
    // retrieved `content` is surfaced as item.text at `full`; a reference without
    // content carries none. The verbatim injection stays the separate context blob.
    const report = buildLightRAGProvenance("injected blob", "hybrid", "full", undefined, [
      { file_path: "a.md", content: "retrieved chunk A", score: 0.9 },
      { file_path: "b.md" }, // no content → no text
    ]);
    const a = report!.items.find((i) => i.file_name === "a.md");
    assert.equal(a?.text, "retrieved chunk A");
    assert.equal(a?.score, 0.9);
    const b = report!.items.find((i) => i.file_name === "b.md");
    assert.equal(b?.text, undefined);
    const ctxItem = report!.items.find((i) => i.id === "lightrag-context");
    assert.equal(ctxItem?.text, "injected blob");
  });

  it("metadata: a reference's content is NOT emitted as text, but its score IS", () => {
    // Excerpts are gated on `full` (operator opt-in); scores are metadata-level.
    const report = buildLightRAGProvenance("ctx", "hybrid", "metadata", undefined, [
      { file_path: "a.md", content: "retrieved chunk A", score: 0.7 },
    ]);
    const a = report!.items.find((i) => i.file_name === "a.md");
    assert.equal(a?.text, undefined);
    assert.equal(a?.score, 0.7);
  });

  it("3.2.13: a doc's `File Name:` header becomes item.title; file_name stays the gdrive key", () => {
    const report = buildLightRAGProvenance("blob", "hybrid", "metadata", undefined, [
      {
        file_path: "gdrive/abc123def456",
        content:
          "--- Document Metadata ---\nFile Name: Rapport Q3.docx\nFile ID: x\n---\nCorps",
      },
      { file_path: "gdrive/no-header-chunk", content: "mid-document, no header" },
    ]);
    const withName = report!.items.find((i) => i.file_name === "gdrive/abc123def456");
    assert.equal(withName?.title, "Rapport Q3.docx"); // readable name surfaced
    assert.equal(withName?.file_name, "gdrive/abc123def456"); // retrieval key unchanged
    const noName = report!.items.find((i) => i.file_name === "gdrive/no-header-chunk");
    assert.equal(noName?.title, undefined); // no header → falls back to file_name
  });

  it("full: bounds a reference excerpt to PROVENANCE_EXCERPT_MAX_CHARS", () => {
    const long = "x".repeat(5000);
    const report = buildLightRAGProvenance("blob", "hybrid", "full", undefined, [
      { file_path: "a.md", content: long },
    ]);
    const a = report!.items.find((i) => i.file_name === "a.md");
    assert.equal(a?.text?.length, PROVENANCE_EXCERPT_MAX_CHARS);
  });

  it("dedups references by file_path, preserving first-seen order", () => {
    const report = buildLightRAGProvenance("ctx", "hybrid", "metadata", undefined, [
      { file_path: "a.md", reference_id: "1" },
      { file_path: "a.md", reference_id: "99" }, // dup → dropped
      { file_path: "b.md" },
    ]);
    const fileNames = report!.items.filter((i) => i.file_name).map((i) => i.file_name);
    assert.deepEqual(fileNames, ["a.md", "b.md"]);
  });

  it("caps total items at PROVENANCE_MAX_ITEMS, always keeping the context item", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ file_path: `f${i}.md` }));
    const report = buildLightRAGProvenance("ctx", "hybrid", "metadata", undefined, many);
    assert.ok(report!.items.length <= PROVENANCE_MAX_ITEMS);
    // The context blob item is never dropped by the cap.
    assert.ok(report!.items.some((i) => i.id === "lightrag-context"));
  });

  it("empty context + non-empty references -> still null (nothing injected)", () => {
    const report = buildLightRAGProvenance("", "hybrid", "full", undefined, [
      { file_path: "a.md" },
    ]);
    assert.equal(report, null);
  });
});

describe("emitProvenanceReports (fail-silent guards)", () => {
  const REPORT = buildLightRAGProvenance("ctx", "mix", "metadata");

  it("emits each non-null report on the scoped stream with runId/sessionKey", () => {
    const seen: Record<string, unknown>[] = [];
    const emit = (event: { runId: string; stream: string; data: unknown }) => {
      seen.push(event as unknown as Record<string, unknown>);
      return { emitted: true };
    };
    const { logger, warnings } = fakeLogger();
    emitProvenanceReports(emit, logger, "run-1", "sess-1", [REPORT, null, REPORT]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.stream, PROVENANCE_STREAM);
    assert.equal(seen[0]!.runId, "run-1");
    assert.equal(seen[0]!.sessionKey, "sess-1");
    assert.equal(warnings.length, 0);
  });

  it("no emitter / no runId -> total silence (never throws)", () => {
    const { logger } = fakeLogger();
    emitProvenanceReports(undefined, logger, "run-1", undefined, [REPORT]);
    const emit = mock.fn(() => ({ emitted: true }));
    emitProvenanceReports(emit, logger, undefined, undefined, [REPORT]);
    assert.equal(emit.mock.callCount(), 0);
  });

  it("a gateway rejection is logged as a stable category code (codex pass #36 P2)", () => {
    // The raw `reason` may echo back the rejected payload (e.g. validation
    // failures often include the offending field/value). To respect the
    // module-level "report content never reaches logs" invariant, the
    // warning MUST contain a stable category code and NEVER the raw reason.
    const emit = mock.fn(() => ({ emitted: false, reason: "plugin is not loaded" }));
    const { logger, warnings } = fakeLogger();
    emitProvenanceReports(emit, logger, "run-1", undefined, [REPORT]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /plugin_not_loaded/);
    assert.ok(!warnings[0]!.includes("plugin is not loaded"));
  });

  it("classifies common rejection reasons to stable codes", () => {
    const cases: Array<[string, string]> = [
      ["plugin is not loaded", "plugin_not_loaded"],
      ["missing runId on event", "missing_run_context"],
      ["unknown session", "missing_run_context"],
      ["stream not whitelisted", "invalid_stream"],
      ["schema validation failed: data.items[0].text too long", "validation_error"],
      ["rate limit exceeded", "rate_limited"],
      ["something exotic", "rejected"],
    ];
    for (const [reason, code] of cases) {
      const emit = mock.fn(() => ({ emitted: false, reason }));
      const { logger, warnings } = fakeLogger();
      emitProvenanceReports(emit, logger, "run-1", undefined, [REPORT]);
      assert.equal(warnings.length, 1, `case: ${reason}`);
      assert.match(warnings[0]!, new RegExp(code), `case: ${reason} -> ${code}`);
      // The raw reason MUST NOT leak through.
      assert.ok(
        !warnings[0]!.includes(reason),
        `raw reason leaked for case: ${reason}`,
      );
    }
  });

  it("an emitter that throws is contained AND its message is never logged (codex pass #36 P2)", () => {
    // Same sanitization invariant as the rejection path: Error.message can
    // carry whatever the SDK / gateway / userland code stuffed in there
    // (third-party libs commonly enrich it with input data, including
    // payload excerpts). Log only the constructor name, never `.message`.
    const emit = mock.fn(() => {
      throw new Error("socket gone: secret-payload-fragment-xyz");
    });
    const { logger, warnings } = fakeLogger();
    emitProvenanceReports(emit, logger, "run-1", undefined, [REPORT]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /throw:Error/);
    assert.ok(!warnings[0]!.includes("socket gone"));
    assert.ok(!warnings[0]!.includes("secret-payload-fragment-xyz"));
  });

  it("an emitter that throws a non-Error value is contained without crashing", () => {
    const emit = mock.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "plain string error";
    });
    const { logger, warnings } = fakeLogger();
    emitProvenanceReports(emit, logger, "run-1", undefined, [REPORT]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /throw:Error/);
    assert.ok(!warnings[0]!.includes("plain string error"));
  });
});

describe("resolveEmitAgentEvent (SDK feature detection)", () => {
  it("binds the function when present; undefined otherwise", () => {
    const api = {
      emitAgentEvent(this: unknown) {
        return { emitted: true, self: this };
      },
    };
    const bound = resolveEmitAgentEvent(api);
    assert.ok(bound);
    const res = bound!({ runId: "r", stream: "s", data: {} }) as { self: unknown };
    assert.equal(res.self, api); // bound to the api (gateway state lookup)
    assert.equal(resolveEmitAgentEvent({}), undefined);
    assert.equal(resolveEmitAgentEvent(null), undefined);
  });
});
