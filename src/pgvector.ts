// PostgreSQL / pgvector search helpers.
//
// The HNSW index for our 3072-dimensional embeddings is built on
// `halfvec(3072)` because pgvector's HNSW implementation caps at 2000 dims
// for the native `vector` type. Both the column cast and the query parameter
// cast must match, otherwise the planner falls back to a sequential scan.

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

  try {
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
  } catch {
    return [];
  }
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
