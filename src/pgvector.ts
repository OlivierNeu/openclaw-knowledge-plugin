// PostgreSQL / pgvector search helpers.
//
// The HNSW index for our 3072-dimensional embeddings is built on
// `halfvec(3072)` because pgvector's HNSW implementation caps at 2000 dims
// for the native `vector` type. Both the column cast and the query parameter
// cast must match, otherwise the planner falls back to a sequential scan.
//
// As of v3.2.0, results from `searchCollection` may optionally be re-ordered
// by a Jina cross-encoder reranker (see `rerankPgvectorResults`). The vector
// search remains the recall stage; the reranker is the precision stage.

import { rerank } from "./jina/reranker.js";
import { JinaError } from "./jina/errors.js";
import type { RpmMonitor } from "./jina/rate-limit.js";
import type { RerankerModel } from "./jina/types.js";
import type { PgPoolLike, PgvectorResult, PgvectorRow } from "./types.js";

const SEARCH_SQL = `SELECT file_name, mime_type, text, file_id, source, owner,
              chunk_index, total_chunks, timestamp_start, timestamp_end,
              embedded_at,
              1 - (embedding::halfvec(3072) <=> $1::halfvec(3072)) AS score
       FROM knowledge_vectors
       WHERE collection = $2
       ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072)
       LIMIT $3`;

/**
 * Search a single collection in `knowledge_vectors` using cosine similarity.
 *
 * Score filtering is performed in JS after the query rather than in SQL so
 * the HNSW index can handle `ORDER BY ... <=> ... LIMIT $3` efficiently
 * (a WHERE clause on the computed score would defeat the index).
 *
 * On any database error we swallow the exception and return an empty array —
 * the plugin must never block the agent, so a DB hiccup degrades gracefully.
 */
export async function searchCollection(
  pool: PgPoolLike,
  collection: string,
  vector: number[],
  topK: number,
  scoreThreshold: number,
): Promise<PgvectorResult[]> {
  const vectorStr = `[${vector.join(",")}]`;

  // Errors are intentionally NOT swallowed here. v3.2.3+ relies on the
  // caller (`runPgvectorSource`) to use `Promise.allSettled` and distinguish
  // "ran and found nothing" (empty array) from "the SQL failed" (rejection)
  // so the observability event accurately reflects what happened.
  const result = await pool.query(SEARCH_SQL, [vectorStr, collection, topK]);

  // pg returns numeric columns as strings by default, so parse the score.
  return result.rows
    .map((row: PgvectorRow): PgvectorResult => ({
      collection,
      score: parseFloat(row.score),
      file_name: row.file_name ?? null,
      mime_type: row.mime_type ?? null,
      text: row.text ?? null,
      file_id: row.file_id ?? null,
      source: row.source ?? null,
      owner: row.owner ?? null,
      chunk_index: row.chunk_index ?? null,
      total_chunks: row.total_chunks ?? null,
      timestamp_start: row.timestamp_start ?? null,
      timestamp_end: row.timestamp_end ?? null,
    }))
    .filter((row) => row.score >= scoreThreshold);
}

/**
 * Format pgvector results for injection into the system prompt.
 * Respects a character budget so we never blow the context window with a
 * single oversized chunk — entries are appended whole until the budget is hit.
 *
 * Returns `null` when there is nothing useful to inject so the caller can
 * easily skip empty sections.
 */
export function formatPgvectorResults(
  results: PgvectorResult[],
  maxChars: number,
): string | null {
  if (results.length === 0) return null;

  let output = "";
  for (const r of results) {
    const lines: string[] = [
      `[${r.collection}] ${r.file_name ?? "unknown"} (score: ${r.score.toFixed(2)})`,
    ];

    if (r.timestamp_start) {
      lines.push(`Segment: ${r.timestamp_start} - ${r.timestamp_end ?? ""}`);
    }

    if (r.text) {
      lines.push(`Content: ${r.text}`);
    }

    lines.push(""); // blank line separator between entries
    const entry = lines.join("\n");

    if (output.length + entry.length > maxChars) break;
    output += entry;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Reranker integration (v3.2.0)
// ---------------------------------------------------------------------------

export interface RerankPgvectorParams {
  apiKey: string;
  query: string;
  model?: RerankerModel;
  /** Cap on the number of results returned post-rerank. */
  topN?: number;
  /**
   * Maximum number of candidates submitted to Jina. The cosine-ranked
   * top `candidatePoolMax` results are sent; anything beyond is dropped
   * client-side BEFORE the API call. Trims Jina token spend on noisy
   * recall (typical pgvector returns 20-50 hits where only 10-15 are
   * worth reranking).
   *
   * Default in the resolver: 20. `undefined` → no cap (legacy v3.2.3
   * behavior).
   *
   * @since 3.2.4
   */
  candidatePoolMax?: number;
  /**
   * Pre-truncation length per candidate document, in CHARACTERS (the
   * Jina API charges per token; characters are a coarse proxy ≈ 4× tokens
   * for typical text). Each `documents[i]` is `slice(0, maxCharsPerDoc)`
   * before submission. Long chunks (recipes, transcripts, prose) carry
   * most of their relevance in the first few hundred chars — the tail
   * costs tokens without adding signal.
   *
   * Default in the resolver: 2000 (≈ 500 tokens). `undefined` → no
   * truncation (legacy v3.2.3 behavior).
   *
   * @since 3.2.4
   */
  maxCharsPerDoc?: number;
  /**
   * Optional callback fired AFTER a successful Jina call with the
   * payload-level numbers the plugin's `jina` event emitter needs
   * (inputCount, total characters sent, duration). Kept as a callback
   * to avoid coupling pgvector.ts to the tracing module.
   *
   * @since 3.2.4
   */
  onUsage?: (usage: {
    inputCount: number;
    totalChars: number;
    durationMs: number;
  }) => void;
  /** Optional RPM monitor (forwarded to the Jina client). @since 3.2.4 */
  rpmMonitor?: RpmMonitor;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Re-order `results` using the Jina cross-encoder reranker.
 *
 * This is the precision stage on top of pgvector's recall: the cosine pass
 * grabs ~20 coarse candidates, the reranker promotes the ones that actually
 * match the user's intent.
 *
 * Contract:
 * - On success, returns at most `topN` items in descending relevance order.
 *   The original cosine `score` is **preserved** on each item; the reranker
 *   produces its own score we expose via the log event, not in the
 *   PgvectorResult.
 * - On any error (including auth / rate limit), throws a `JinaError`. The
 *   caller is responsible for falling back to the original cosine order —
 *   we do NOT swallow here because the caller wants to track the failure
 *   for the cooldown breaker.
 * - On empty input, returns `[]` without hitting the network.
 */
export async function rerankPgvectorResults(
  results: PgvectorResult[],
  params: RerankPgvectorParams,
): Promise<PgvectorResult[]> {
  if (results.length === 0) return [];

  // The reranker only sees the textual content. Empty/null texts cannot be
  // ranked, so we filter them out BEFORE the API call to avoid wasting
  // tokens on rows the cross-encoder can't score anyway.
  let indexed = results
    .map((r, i) => ({ row: r, originalIndex: i, text: r.text ?? "" }))
    .filter((x) => x.text.trim().length > 0);

  if (indexed.length === 0) return results.slice(0, params.topN ?? results.length);

  // 3.2.4 — payload-size guards. Both are no-ops when undefined so the
  // legacy behavior is preserved for callers that haven't migrated.
  if (
    typeof params.candidatePoolMax === "number" &&
    params.candidatePoolMax > 0 &&
    indexed.length > params.candidatePoolMax
  ) {
    // `results` is already cosine-sorted by the caller (runPgvectorSource).
    // `indexed` preserves that order via the `originalIndex` mapping, so
    // slicing to the first N keeps the best candidates and drops the tail.
    indexed = indexed.slice(0, params.candidatePoolMax);
  }
  const documents =
    typeof params.maxCharsPerDoc === "number" && params.maxCharsPerDoc > 0
      ? indexed.map((x) => x.text.slice(0, params.maxCharsPerDoc))
      : indexed.map((x) => x.text);

  const startedAt = Date.now();
  try {
    const reranked = await rerank({
      apiKey: params.apiKey,
      query: params.query,
      documents,
      model: params.model,
      topN: params.topN,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      rpmMonitor: params.rpmMonitor,
    });

    if (params.onUsage) {
      const totalChars = documents.reduce((sum, d) => sum + d.length, 0);
      params.onUsage({
        inputCount: documents.length,
        totalChars,
        durationMs: Date.now() - startedAt,
      });
    }

    if (reranked.length === 0) {
      // Defensive: reranker returned no usable items. Surface the original
      // cosine order rather than wiping the candidate list.
      return results.slice(0, params.topN ?? results.length);
    }

    // Map back to PgvectorResult using the reranker's `index` (which points
    // into our filtered `indexed` array, NOT the original `results` array).
    const out: PgvectorResult[] = [];
    for (const item of reranked) {
      const found = indexed[item.index];
      if (found) out.push(found.row);
    }
    return out;
  } catch (err) {
    // Re-throw only if it's a Jina error the caller will recognize. Any
    // other failure (programmer error) propagates as-is.
    if (err instanceof JinaError) throw err;
    throw err;
  }
}
