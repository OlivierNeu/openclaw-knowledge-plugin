// Jina AI API request/response types.
//
// Documented at:
//   https://jina.ai/classifier/   (POST /v1/classify, zero-shot + few-shot)
//   https://jina.ai/reranker/     (POST /v1/rerank)
//
// We deliberately keep the response shapes flexible (`unknown`-leaning) so the
// parser can stay defensive: Jina has changed field names between iterations
// (e.g. `predictions[]` vs `results[]`), and a brittle interface would mask
// silent breakage. Strong typing happens at the parser boundary.

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/**
 * Embedding model used as backbone for Classifier zero-shot requests.
 * The Reranker endpoint uses its own model identifiers (see RerankerModel).
 */
export type ClassifierEmbeddingModel =
  | "jina-embeddings-v3"
  | "jina-embeddings-v4"
  | "jina-clip-v2";

/**
 * Supported Jina reranker models.
 *
 * - `jina-reranker-v2-base-multilingual` (default in this plugin) — trained on
 *   100+ languages, ideal for French content. Context cap: 8 192 tokens.
 * - `jina-reranker-v3` — bigger context (131 K), primarily English-trained.
 * - `jina-reranker-m0` — multimodal.
 * - `jina-colbert-v2` — late-interaction.
 */
export type RerankerModel =
  | "jina-reranker-v2-base-multilingual"
  | "jina-reranker-v3"
  | "jina-reranker-m0"
  | "jina-colbert-v2"
  | (string & {}); // allow forward-compat custom values without losing autocomplete

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Input element for the Classifier endpoint. Text-only is what the plugin
 * uses; the API also supports `{image: "..."}` with `jina-clip-v2`, but the
 * router never classifies images.
 */
export interface ClassifierTextInput {
  text: string;
}

/**
 * Zero-shot classification request body for POST /v1/classify.
 *
 * `labels` must contain semantic category strings (the Classifier embeds
 * them and picks the closest one to each input). At least 2 labels.
 */
export interface JinaClassifyZeroShotRequest {
  model: ClassifierEmbeddingModel;
  input: ClassifierTextInput[];
  labels: string[];
}

/**
 * Few-shot classification request body for POST /v1/classify (with a
 * pre-trained classifier_id obtained out-of-band — the plugin does NOT
 * implement /v1/train; operators train via the Jina Playground or CLI and
 * paste the ID into the plugin config).
 */
export interface JinaClassifyFewShotRequest {
  classifier_id: string;
  input: ClassifierTextInput[];
}

export type JinaClassifyRequest =
  | JinaClassifyZeroShotRequest
  | JinaClassifyFewShotRequest;

/**
 * Normalized classification outcome as seen by the rest of the plugin.
 * `label` is the picked class. `score` is the confidence in [0, 1] when
 * Jina returns it; `null` when the field is not in the response (the
 * defensive parser still produces a label in that case).
 */
export interface ClassificationOutcome {
  label: string;
  score: number | null;
}

// ---------------------------------------------------------------------------
// Reranker
// ---------------------------------------------------------------------------

/**
 * Reranker request body for POST /v1/rerank.
 *
 * We always send `return_documents: false`: the caller already holds the
 * original documents (PgvectorResult[]) and only needs the new ordering. This
 * saves a meaningful chunk of egress tokens on large payloads.
 */
export interface JinaRerankRequest {
  model: RerankerModel;
  query: string;
  documents: string[];
  top_n?: number;
  return_documents: false;
  truncate?: boolean;
}

/**
 * Single reranked result item — `index` references the original `documents`
 * array position.
 */
export interface RerankedItem {
  index: number;
  score: number;
}
