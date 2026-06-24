// Provenance reporting (provenance/v1) — what this plugin ACTUALLY injected
// into the LLM, emitted on the gateway agent-event bus so a chat frontend
// (openclaw-webchat) can show the user "which documents fed this reply".
//
// Normative contract: openclaw-webchat docs/PROVENANCE_CONTRACT.md.
// Transport rules (gateway-enforced, bench-verified 2026-06-12):
//   - stream MUST be scoped to this plugin: "openclaw-knowledge.provenance";
//   - runId is REQUIRED (the before_prompt_build ctx carries it);
//   - the gateway stamps pluginId/pluginName into `data` (authenticated
//     emitter identity — we never claim it ourselves);
//   - a violation returns `{emitted:false, reason}` WITHOUT throwing.
//
// PRIVACY: this channel is DISTINCT from the tracing events module — reports
// land in the chat frontend's store under the chat's own ACL. The level knob
// keeps content out unless the operator opts in:
//   - "off"      (default): no emission at all;
//   - "metadata": items WITHOUT text (file names, collections, scores);
//   - "full":     plus the exact injected excerpts.
// The tracing invariant is untouched: NOTHING here goes through logs.

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { extractDocumentTitle } from "./lightrag.js";
import type { LightRAGReference, PgvectorResult } from "./types.js";

export type ProvenanceReportLevel = "off" | "metadata" | "full";

export const PROVENANCE_REPORT_LEVELS: readonly ProvenanceReportLevel[] = [
  "off",
  "metadata",
  "full",
];

/** Gateway-scoped stream this plugin emits on (see contract §2). */
export const PROVENANCE_STREAM = "openclaw-knowledge.provenance";

/** Mirrors the consumer's per-item excerpt bound (contract §3). */
export const PROVENANCE_EXCERPT_MAX_CHARS = 2_000;

/** Mirrors the consumer's per-report item cap (contract §3). */
export const PROVENANCE_MAX_ITEMS = 24;

export interface ProvenanceItemV1 {
  id?: string;
  type?: string;
  date?: string;
  score?: number;
  text?: string;
  file_name?: string;
  /** provenance/v1 (additive): a human DISPLAY name for a document item. When present
   *  the UI shows it as the title instead of `file_name`; `file_name` remains the stable
   *  retrieval/attach key (for LightRAG, the gdrive `file_source`). */
  title?: string;
  collection?: string;
  /** provenance/v1 (additive): declares a SYNTHESIZED context excerpt (no openable
   *  source file) within a `documents` report — see Atrium's PROVENANCE_CONTRACT.md.
   *  Atrium renders it under "Context", never as a findable/attachable document. */
  context?: boolean;
}

export interface ProvenanceReportV1 {
  v: 1;
  source: "knowledge";
  kind: "documents";
  injected?: { chars?: number; position?: string; truncated?: boolean };
  retrieval?: {
    route?: string;
    collections?: string[];
    lightrag?: { mode?: string };
  };
  items: ProvenanceItemV1[];
}

/** Structural emitAgentEvent surface (the installed SDK types may predate it). */
export type EmitAgentEventFn = (event: {
  runId: string;
  sessionKey?: string;
  stream: string;
  data: unknown;
}) => unknown;

/** Normalize the operator's config value; anything off-list means "off". */
export function resolveProvenanceLevel(raw: unknown): ProvenanceReportLevel {
  return PROVENANCE_REPORT_LEVELS.includes(raw as ProvenanceReportLevel)
    ? (raw as ProvenanceReportLevel)
    : "off";
}

/**
 * Feature-detect emitAgentEvent on the (first-registration) plugin api.
 *
 * GATEWAY QUIRK (bench-verified 2026-06-12): the agent runtime RE-REGISTERS
 * plugins per run, and emitting through a re-registration's api is rejected
 * `"plugin is not loaded"` — callers MUST pass the FIRST registration's api
 * (module-level singleton; see registerKnowledgePlugin).
 */
export function resolveEmitAgentEvent(api: unknown): EmitAgentEventFn | undefined {
  const candidate = (api as { emitAgentEvent?: unknown })?.emitAgentEvent;
  if (typeof candidate !== "function") return undefined;
  return candidate.bind(api) as EmitAgentEventFn;
}

/**
 * Report for an injected pgvector section. `data` is the FINAL injected list
 * (post-rerank, post-topN — exactly what reached the LLM). Returns null when
 * the level is "off" or there is nothing citable.
 */
export function buildPgvectorProvenance(
  data: PgvectorResult[],
  collections: string[],
  level: ProvenanceReportLevel,
  injectedChars: number,
): ProvenanceReportV1 | null {
  if (level === "off" || data.length === 0) return null;
  const items: ProvenanceItemV1[] = data
    .slice(0, PROVENANCE_MAX_ITEMS)
    .map((r) => {
      const item: ProvenanceItemV1 = { collection: r.collection, score: r.score };
      if (r.file_name) item.file_name = r.file_name;
      else if (r.file_id) item.id = r.file_id;
      if (level === "full" && r.text) {
        item.text = r.text.slice(0, PROVENANCE_EXCERPT_MAX_CHARS);
      }
      return item;
    });
  return {
    v: 1,
    source: "knowledge",
    kind: "documents",
    injected: { chars: injectedChars, position: "system_append" },
    retrieval: { route: "pgvector", collections },
    items,
  };
}

/**
 * Report for an injected LightRAG section. The graph response is one opaque
 * context blob (no per-document structure yet — the docstore initiative will
 * enrich this), so the report carries ONE item describing the injected
 * context; "full" includes its leading excerpt VERBATIM from what was
 * actually injected (the post-truncation text).
 *
 * @param injectedText  body of the section actually delivered to the LLM
 *                      (post-truncation, header EXCLUDED). Used for the
 *                      `full`-level excerpt.
 * @param mode          LightRAG query mode (`mix`, `hybrid`, …).
 * @param level         provenance gate (`off` / `metadata` / `full`).
 * @param injectedChars total length of the system-prompt section actually
 *                      delivered (header INCLUDED). Defaults to
 *                      `injectedText.length` for callers that don't track
 *                      the header separately; the plugin's render path
 *                      passes the full section length so `injected.chars`
 *                      reflects exactly what reached the LLM
 *                      (codex pass #36 P3). Negative values fall back to
 *                      `injectedText.length` to keep the report
 *                      well-formed even on caller mistakes.
 * @param references    source documents LightRAG attributed this context to
 *                      (since 3.2.8). Each becomes a findable document item
 *                      (`file_name` = path) AND, since 3.2.12, carries its
 *                      RETRIEVED `content` as the item's `text` (gated on
 *                      `full`) plus a `score` when LightRAG provides one — so
 *                      the user sees the source material the RAG pulled per
 *                      document. This is a DELIBERATE semantic choice for the
 *                      user's own Sources panel: unlike pgvector (whose
 *                      `item.text` is the verbatim injected chunk), a LightRAG
 *                      reference's `content` is the RETRIEVED source text, which
 *                      is richer than the synthesized injection (it is not
 *                      subject to the `lightragMaxChars` truncation). The
 *                      verbatim, truncated injection stays the separate
 *                      `lightrag-context` blob item below; the two are
 *                      complementary, never conflated. The empty-context guard
 *                      still wins: no injected text → no report, even with refs.
 */
export function buildLightRAGProvenance(
  injectedText: string,
  mode: string,
  level: ProvenanceReportLevel,
  injectedChars?: number,
  references: LightRAGReference[] = [],
): ProvenanceReportV1 | null {
  if (level === "off" || injectedText.length === 0) return null;

  // Source-attribution items: one per UNIQUE file_path, order preserved
  // (LightRAG returns them ranked). Reserve one slot for the context blob
  // item so it is never dropped by the cap.
  const refItems: ProvenanceItemV1[] = [];
  const seen = new Set<string>();
  for (const ref of references) {
    if (refItems.length >= PROVENANCE_MAX_ITEMS - 1) break;
    if (seen.has(ref.file_path)) continue;
    seen.add(ref.file_path);
    // Document items are identified by `file_name` per PROVENANCE_CONTRACT §3
    // (only memory items use `id`). LightRAG's `reference_id` is a per-query
    // ordinal ("1", "2", …) — unstable and collision-prone as an item key —
    // so it is intentionally NOT surfaced here. `file_path` is the key.
    const item: ProvenanceItemV1 = { file_name: ref.file_path, type: mode };
    // The readable document NAME (the ingestion pipeline's `File Name:` metadata header,
    // embedded in the retrieved content) becomes the display `title`; `file_name` stays
    // LightRAG's `file_path` (the stable gdrive retrieval/attach/search key). Falls back
    // to file_name when no header is present.
    const title = extractDocumentTitle(ref.content);
    if (title) item.title = title;
    // Since 3.2.12: surface the per-document RETRIEVED content + score so the user
    // sees the source material the RAG pulled for each document. `text` is gated on
    // `full` (operator opt-in) and bounded like every excerpt. This is the retrieved
    // source content per document — complementary to, NOT a copy of, the synthesized
    // `lightrag-context` blob (the verbatim, truncated injection). Because LightRAG's
    // per-reference content is a SEPARATE field, it is not subject to the
    // `lightragMaxChars` truncation, so the user sees each document's relevant content
    // even when the injected blob was heavily truncated.
    if (typeof ref.score === "number") item.score = ref.score;
    if (level === "full" && ref.content) {
      item.text = ref.content.slice(0, PROVENANCE_EXCERPT_MAX_CHARS);
    }
    refItems.push(item);
  }

  // The single blob item is the ONLY carrier of injected (post-truncation) text,
  // gated on `full` exactly as before. `context: true` declares it a synthesized
  // excerpt so Atrium renders it under "Context", NOT as a findable document (its
  // `id` is a sentinel, not a real file).
  const contextItem: ProvenanceItemV1 = {
    id: "lightrag-context",
    type: mode,
    context: true,
  };
  if (level === "full") {
    contextItem.text = injectedText.slice(0, PROVENANCE_EXCERPT_MAX_CHARS);
  }

  const reportedChars =
    typeof injectedChars === "number" && injectedChars >= 0
      ? injectedChars
      : injectedText.length;
  return {
    v: 1,
    source: "knowledge",
    kind: "documents",
    injected: { chars: reportedChars, position: "system_append" },
    retrieval: { route: "lightrag", lightrag: { mode } },
    items: [...refItems, contextItem],
  };
}

/**
 * Stable categories logged when emission fails. Operators triage by code;
 * the underlying gateway reason / Error message is intentionally NEVER
 * passed to the logger because in `full` mode it may echo back the
 * payload (excerpts of the injected documents) it was rejecting — and the
 * tracing invariant of this module is that report content never reaches
 * logs.
 *
 * @since 3.2.5 (codex pass #36 P2 — sanitize emission failure logs)
 */
export type ProvenanceEmitFailureCode =
  | "plugin_not_loaded"
  | "missing_run_context"
  | "invalid_stream"
  | "validation_error"
  | "rate_limited"
  | "rejected"
  | "throw";

/**
 * Map a gateway-supplied `reason` to a stable category code. Matching is
 * substring-based on the lower-cased reason — coarse on purpose so a
 * future gateway wording change does not break the classifier silently.
 * Unknown reasons collapse to `"rejected"` so the field always has a
 * non-empty, content-free value.
 */
function classifyRejectionReason(reason: string | undefined): ProvenanceEmitFailureCode {
  if (!reason) return "rejected";
  const lower = reason.toLowerCase();
  if (lower.includes("not loaded")) return "plugin_not_loaded";
  if (lower.includes("runid") || lower.includes("session")) {
    return "missing_run_context";
  }
  if (lower.includes("stream")) return "invalid_stream";
  if (lower.includes("validation") || lower.includes("schema")) {
    return "validation_error";
  }
  if (lower.includes("rate") || lower.includes("limit")) return "rate_limited";
  return "rejected";
}

/**
 * Emit the turn's reports. Every guard degrades to SILENCE (a missing SDK
 * function, a missing runId, a gateway rejection) — provenance must never
 * break or delay a turn. Failures are logged as a STABLE CATEGORY CODE
 * (never the raw gateway reason or Error message) because a silent
 * `{emitted:false}` is undiagnosable in the field, but echoing the raw
 * reason could leak fragments of the injected payload back into the log
 * stream — violating the module's tracing invariant.
 */
export function emitProvenanceReports(
  emit: EmitAgentEventFn | undefined,
  logger: PluginLogger,
  runId: string | undefined,
  sessionKey: string | undefined,
  reports: (ProvenanceReportV1 | null)[],
): void {
  if (!emit) return;
  if (!runId) return; // gateway-required; absent on some triggers
  for (const report of reports) {
    if (report === null) continue;
    try {
      const res = emit({
        runId,
        ...(sessionKey ? { sessionKey } : {}),
        stream: PROVENANCE_STREAM,
        data: report,
      }) as { emitted?: boolean; reason?: string } | undefined;
      if (res && res.emitted === false) {
        const code = classifyRejectionReason(res.reason);
        logger.warn(`openclaw-knowledge: provenance report rejected — ${code}`);
      }
    } catch (err) {
      // Log only the Error.name (`TypeError`, `RangeError`, ...) — NEVER the
      // `.message`, which third-party libs commonly enrich with input data.
      const name =
        err && typeof err === "object" && typeof (err as Error).name === "string"
          ? (err as Error).name
          : "Error";
      logger.warn(`openclaw-knowledge: provenance emit failed — throw:${name}`);
    }
  }
}
