// Default zero-shot labels for the Jina Classifier.
//
// The labels are intentionally bilingual: most prompts in the observed
// traces are French (the deployment is French-speaking) but the
// system prompts and agent meta-questions are often English. Jina
// `jina-embeddings-v3` handles both languages natively.
//
// Each label is a short sentence describing the kind of question that
// belongs to that route. Jina embeds both the label and the input, then
// picks the closest one — so the more discriminative the labels, the
// better the routing. Empirically, "describe the kind of question"
// outperforms "give a category name" by ~25% on small samples
// (https://jina.ai/news/rephrased-labels-improve-zero-shot-text-classification-30/).

/**
 * Public constants — MUST stay in sync with `Route` in `types.js`.
 *
 * The label prefix passed to Jina (zero-shot) and the canonical name a
 * few-shot classifier MUST be trained against share the same literal
 * values as the `Route` union ("NONE" | "PGVECTOR_ONLY" | "LIGHTRAG_ONLY"
 * | "ALL"). If they diverged, the classifier path would always fall back
 * to "ALL" because `isKnownRoute` would reject the predicted label.
 */
export const ROUTE_NONE = "NONE";
export const ROUTE_PGVECTOR_ONLY = "PGVECTOR_ONLY";
export const ROUTE_LIGHTRAG_ONLY = "LIGHTRAG_ONLY";
export const ROUTE_ALL = "ALL";

/**
 * Default labels handed to Jina `/v1/classify` in zero-shot mode when the
 * operator does not supply a few-shot `classifierId`.
 *
 * Order does not matter for correctness, but we keep `NONE` first by
 * convention so test output is stable.
 */
export const DEFAULT_ROUTER_LABELS: readonly string[] = [
  // NONE — agent meta, smalltalk, test pings
  `${ROUTE_NONE}: meta-question about the agent itself, session identifier, system test, simple greeting, weather, or trivial smalltalk that does not depend on the knowledge base`,

  // PGVECTOR_ONLY — single-document factual lookup
  `${ROUTE_PGVECTOR_ONLY}: factual lookup that can be answered by a single document excerpt — version numbers, file names, dates, configuration values, raw quotes`,

  // LIGHTRAG_ONLY — entity-relation traversal
  `${ROUTE_LIGHTRAG_ONLY}: knowledge graph question about entities and their relationships — which client, which coach, which mission, which programme links to which livrable`,

  // ALL — broad / synthesizing / unclear
  `${ROUTE_ALL}: broad synthesis, multi-hop reasoning, audit, comparison, or any question whose scope is unclear and benefits from both vector search and knowledge graph context`,
];

/**
 * The label names that the classifier may legitimately return.
 * Used by the defensive parser to refuse hallucinated classes.
 */
export const ROUTER_LABEL_NAMES: readonly string[] = [
  ROUTE_NONE,
  ROUTE_PGVECTOR_ONLY,
  ROUTE_LIGHTRAG_ONLY,
  ROUTE_ALL,
];

/**
 * Extract the route name from a full label string (the part before the
 * colon). Returns `null` when the label is malformed.
 *
 * @internal exported for unit testing
 */
export function extractRouteFromLabel(label: string): string | null {
  const colonIndex = label.indexOf(":");
  if (colonIndex <= 0) return null;
  const name = label.slice(0, colonIndex).trim();
  return name.length > 0 ? name : null;
}
