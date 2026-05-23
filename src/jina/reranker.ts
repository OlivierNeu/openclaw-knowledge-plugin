// Jina Reranker client.
//
// Wraps POST /v1/rerank for use after a pgvector cosine-similarity pass:
// vector search returns N coarse candidates, then a cross-encoder rerank
// promotes the ones that actually answer the query.
//
// Implementation choices:
//
// 1. **`return_documents: false` is hardcoded.** The caller (pgvector source)
//    already owns the `PgvectorResult` objects and only needs the new
//    ordering. Asking Jina to echo the documents back would multiply the
//    response payload by ~10× for nothing.
//
// 2. **`truncate: true` by default.** Lets Jina silently shrink each document
//    to the model's per-doc cap rather than failing the whole batch. The
//    LightRAG-side reranker uses the same setting (`RERANK_ENABLE_CHUNKING`).
//
// 3. **Defensive response parsing.** We validate the structural shape
//    (`results: [{index, score}]`) and silently skip malformed entries
//    rather than crashing. An empty or unrecognized response yields an
//    empty array — the caller falls back to the original cosine order.

import { postJson } from "./client.js";
import type {
  JinaRerankRequest,
  RerankedItem,
  RerankerModel,
} from "./types.js";

const RERANK_URL = "https://api.jina.ai/v1/rerank";

/**
 * Default reranker model. v2-base-multilingual is the best-balanced choice
 * for French-heavy corpora (LightRAG-side tuning notes from 2026-05-14 show
 * v3 plateauing at 0.05-0.15 on short French queries vs dense chunks).
 */
const DEFAULT_RERANKER_MODEL: RerankerModel = "jina-reranker-v2-base-multilingual";

export interface RerankParams {
  apiKey: string;
  query: string;
  /** Document texts to rerank. Order MUST match the caller's source array. */
  documents: string[];
  /** Override the default model. */
  model?: RerankerModel;
  /**
   * Keep only the top-N results. When omitted, Jina returns all reranked
   * items (still useful when the caller wants to keep full ordering).
   */
  topN?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Rerank `documents` against `query` and return the new ordering.
 *
 * Each item carries the ORIGINAL index from the input array plus the new
 * relevance score. Callers should use the `index` to look up their own
 * data structures rather than relying on document text.
 *
 * @returns `[]` for an empty input (no API call) or when the response
 *          shape is unrecognized (fail-open semantics).
 * @throws  on network / auth / API errors so the cooldown breaker can react.
 */
export async function rerank({
  apiKey,
  query,
  documents,
  model = DEFAULT_RERANKER_MODEL,
  topN,
  timeoutMs,
  signal,
}: RerankParams): Promise<RerankedItem[]> {
  if (documents.length === 0) return [];

  const body: JinaRerankRequest = {
    model,
    query,
    documents,
    return_documents: false,
    truncate: true,
  };
  if (typeof topN === "number" && topN > 0) {
    body.top_n = topN;
  }

  const raw = await postJson<JinaRerankRequest>({
    url: RERANK_URL,
    body,
    apiKey,
    timeoutMs,
    signal,
  });

  return parseRerankResponse(raw, documents.length);
}

/**
 * Defensive parser for the /v1/rerank response.
 *
 * @internal exported for unit testing
 */
export function parseRerankResponse(
  raw: unknown,
  inputCount: number,
): RerankedItem[] {
  if (!isRecord(raw)) return [];

  const results = raw.results;
  if (!Array.isArray(results)) return [];

  const out: RerankedItem[] = [];
  for (const item of results) {
    if (!isRecord(item)) continue;
    const index = item.index;
    const score = item.relevance_score ?? item.score;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= inputCount ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    ) {
      continue;
    }
    out.push({ index, score });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
