// LightRAG query client.
//
// LightRAG is a knowledge graph server built on Neo4j + a vector store. We
// call its `/query` endpoint with `only_need_context=true` so it returns the
// assembled context text WITHOUT running its own LLM synthesis — we only need
// the raw context to feed back into OpenClaw's agent.

import type {
  LightRAGQueryMode,
  LightRAGQueryResult,
  LightRAGReference,
} from "./types.js";

interface LightRAGResponsePayload {
  /** Assembled context. Newer builds may use `context`; we accept both. */
  response?: string;
  context?: string;
  /** Structured source references (LightRAG ≥ 1.4.5). */
  references?: unknown;
}

/**
 * Parse the `references` field of a LightRAG response into a clean list.
 *
 * Keeps entries with a non-empty string `file_path`; anything malformed is silently
 * dropped (the references are a best-effort enrichment, never a hard dependency).
 * Returns `[]` for older servers that omit the field entirely, which preserves the
 * pre-3.2.8 behavior end-to-end.
 *
 * Since 3.2.12 the per-document `content` (the retrieved source text) and a per-
 * reference `score` are captured too, when LightRAG provides them, so the chat
 * frontend can show the user the source material per document. Both are optional and
 * defensive: a non-string `content` or non-number `score` is simply omitted.
 *
 * @internal exported for unit testing
 */
/**
 * Normalize a reference's `content` into a single non-empty string, or undefined.
 *
 * LightRAG (with `include_chunk_content: true`) returns `content` as an ARRAY of
 * strings — one per retrieved chunk of the same file, to preserve chunk boundaries
 * (HKUDS/LightRAG ≥ 1.4.9). We join the chunks into one excerpt. A bare string is
 * accepted defensively (older builds / mocks); anything else yields undefined.
 */
export function normalizeReferenceContent(raw: unknown): string | undefined {
  const chunks: string[] = Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === "string" && c.length > 0)
    : typeof raw === "string" && raw.length > 0
      ? [raw]
      : [];
  if (chunks.length === 0) return undefined;
  return chunks.join("\n\n");
}

/**
 * Extract the human document NAME from a reference's content.
 *
 * The knowledge ingestion pipeline (n8n `knowledge-process-changes-jerome`) prepends a
 * metadata header to every document before LightRAG ingestion, with the line
 * `File Name: <name>` on its own line — VERIFIED IDENTICAL in both prepare nodes
 * ("Prepare LightRAG (md)" and "Code (Prepare for LightRAG)"). That name is the readable
 * title (e.g. "2026 03 30 — CR — réunion.docx"), whereas LightRAG's `file_path`
 * (= the pipeline's `file_source`, e.g. `gdrive/<hash>`) is the stable retrieval key.
 * We surface the name as the item's `title` while `file_name` keeps the retrieval key.
 *
 * Returns undefined when no header line is present (the item falls back to file_name) —
 * defensive against a retrieved chunk that does not start at the document head.
 */
const METADATA_HEADER_MARKER = "--- Document Metadata ---";

export function extractDocumentTitle(content: string | undefined): string | undefined {
  if (!content) return undefined;
  // Trust ONLY the ingestion metadata header preamble — and ONLY when it is at the
  // very START of the content. The pipeline builds `enrichedText = header + body`, so a
  // real header is the first thing in the first retrieved chunk. Anchoring at the start
  // rejects a body line (or a chunk that merely CONTAINS the marker) being read as a
  // title — no document-content leak, especially in `metadata` mode.
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(METADATA_HEADER_MARKER)) return undefined;
  const afterMarker = trimmed.slice(METADATA_HEADER_MARKER.length);
  // The header ends at the next line that is exactly `---` (closing) or a sub-section
  // (`--- Frontmatter ---`, …); `File Name:` precedes any of these.
  const endRel = afterMarker.indexOf("\n---");
  const header = endRel === -1 ? afterMarker : afterMarker.slice(0, endRel);
  const m = header.match(/^File Name:[ \t]*(.+?)[ \t]*$/m);
  const name = m?.[1]?.trim();
  return name && name.length > 0 ? name : undefined;
}

export function parseLightRAGReferences(raw: unknown): LightRAGReference[] {
  if (!Array.isArray(raw)) return [];
  const out: LightRAGReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const fp = rec.file_path;
    if (typeof fp !== "string" || fp.length === 0) continue;
    const ref: LightRAGReference = { file_path: fp };
    if (typeof rec.reference_id === "string" && rec.reference_id.length > 0) {
      ref.reference_id = rec.reference_id;
    }
    const content = normalizeReferenceContent(rec.content);
    if (content) ref.content = content;
    if (typeof rec.score === "number" && Number.isFinite(rec.score)) {
      ref.score = rec.score;
    }
    out.push(ref);
  }
  return out;
}

/**
 * Query a LightRAG server for context relevant to `query`.
 *
 * Modes:
 * - `naive`  — simple vector similarity on chunks
 * - `local`  — entity-neighbourhood traversal
 * - `global` — community summaries
 * - `hybrid` — local + global (recommended default)
 *
 * Returns the assembled `context` plus the structured source `references`
 * (empty on servers that don't emit them). The references enable provenance
 * source-attribution; the caller decides whether/how to surface them.
 *
 * `includeChunkContent` asks LightRAG to also return each reference's retrieved
 * chunk text (default off, matching LightRAG's own default). The caller should
 * enable it ONLY when provenance is at `full` — the chunk text can be large and
 * is otherwise unused, so requesting it at off/metadata is pure waste.
 *
 * @throws Error on any non-OK HTTP response, with the first 200 chars of the
 *         error body for debugging.
 */
export async function queryLightRAG(
  url: string,
  apiKey: string,
  query: string,
  mode: LightRAGQueryMode = "hybrid",
  includeChunkContent = false,
  options: LightRAGQueryOptions = {},
): Promise<LightRAGQueryResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const body: Record<string, unknown> = {
    query,
    mode,
    only_need_context: true,
    stream: false,
    // Include each reference's retrieved chunk text in the `references` field
    // (default false → only reference_id + file_path). This is what lets the chat
    // frontend show the per-document source content (the FULL retrieved text, not
    // subject to the `lightragMaxChars` truncation of the assembled blob). Gated by
    // the caller on provenance level `full` — never paid for at off/metadata.
    include_chunk_content: includeChunkContent,
  };
  // Pre-computed keywords make LightRAG skip its LLM keyword-extraction call
  // (`get_keywords_from_query` returns them as-is when either list is
  // non-empty — HKUDS/LightRAG lightrag/operate.py). `naive` never extracts
  // keywords, so they are not sent for it.
  if (mode !== "naive" && options.keywords) {
    const { hl, ll } = options.keywords;
    if (hl.length > 0 || ll.length > 0) {
      body.hl_keywords = hl;
      body.ll_keywords = ll;
    }
  }

  const signal = combineSignals(options.signal, options.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(`${url}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw toLightRAGError(err, signal, options.timeoutMs);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `LightRAG query failed (${resp.status}): ${text.slice(0, 200)}`,
    );
  }

  let data: LightRAGResponsePayload;
  try {
    data = (await resp.json()) as LightRAGResponsePayload;
  } catch (err) {
    throw toLightRAGError(err, signal, options.timeoutMs);
  }
  return {
    context: data.response ?? data.context ?? "",
    references: parseLightRAGReferences(data.references),
  };
}

/**
 * Optional per-call knobs for {@link queryLightRAG}.
 *
 * @since 4.0.0
 */
export interface LightRAGQueryOptions {
  /** Caller cancellation (e.g. the per-turn retrieval budget). */
  signal?: AbortSignal;
  /** Hard timeout for the whole request (headers + body). */
  timeoutMs?: number;
  /** Locally computed keywords; sent as `hl_keywords` / `ll_keywords`. */
  keywords?: { hl: string[]; ll: string[] };
}

/** Raised when a LightRAG call was aborted by its timeout or the caller. @since 4.0.0 */
export class LightRAGTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightRAGTimeoutError";
  }
}

/**
 * Merge an optional caller signal and an optional timeout into one signal.
 * Returns undefined when neither is supplied (legacy: no abort at all).
 *
 * @internal exported for reuse by the pgvector / embedding path
 */
export function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    parts.push(AbortSignal.timeout(timeoutMs));
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

function toLightRAGError(
  err: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Error {
  if (signal?.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    const timedOut = reason?.name === "TimeoutError";
    return new LightRAGTimeoutError(
      timedOut
        ? `LightRAG query timed out after ${timeoutMs ?? "?"}ms`
        : "LightRAG query aborted (retrieval budget)",
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Truncate text to `maxChars` without cutting mid-sentence when possible.
 * Falls back to a raw character cut if no sentence boundary is found in the
 * second half of the allowed window.
 */
export function truncateLightRAG(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5
    ? truncated.slice(0, lastPeriod + 1)
    : truncated;
}

/**
 * Convenience wrapper used by the hook handler: trim the context, truncate
 * it to the configured budget, and return `null` if nothing remains.
 */
export function formatLightRAGResults(
  rawContext: string,
  maxChars: number,
): { truncated: string; originalLength: number } | null {
  const context = rawContext.trim();
  if (context.length === 0) return null;

  return {
    truncated: truncateLightRAG(context, maxChars),
    originalLength: context.length,
  };
}
