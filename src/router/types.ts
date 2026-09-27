// Router types — shared by heuristic + classifier paths.
//
// The router decides which knowledge sources should be queried for a given
// user turn. The decision is consumed by the `before_prompt_build` handler
// to gate calls to pgvector and LightRAG.

/**
 * The four mutually exclusive routes the router can pick.
 *
 *   - `NONE`            — skip every source. Used for heartbeats, cron,
 *                          memory triggers, agent meta-questions, system
 *                          tests. Saves the cost of an irrelevant retrieval.
 *   - `PGVECTOR_ONLY`   — vector search only (no graph). Cheap factual
 *                          lookups: file names, version numbers, simple
 *                          excerpts.
 *   - `LIGHTRAG_ONLY`   — knowledge graph only (no vectors). Multi-hop
 *                          reasoning, entity-relationship queries.
 *   - `ALL`             — both sources in parallel. The current default
 *                          behavior; preserved when the router is disabled.
 */
export type Route = "NONE" | "PGVECTOR_ONLY" | "LIGHTRAG_ONLY" | "ALL";

/** Source of a router decision — used in logs to trace the reasoning path. */
export type RouterReason =
  | "router_disabled"      // routerEnabled=false → ALL
  | "heuristic_trigger"    // skipped by ctx.trigger (heartbeat/cron/memory)
  | "heuristic_meta"       // skipped by meta-question regex
  | "heuristic_short"      // skipped by short-CLI rule
  | "heuristic_keyword"    // routed by keyword match
  | "classifier_hit"             // classifier picked a route with confidence ≥ threshold
  | "classifier_low_confidence"  // classifier score below minConfidence → ALL
  | "classifier_fallback"        // classifier returned null → ALL
  | "classifier_error"           // classifier threw / network → ALL
  // 4.0.0 — pre-router skips (run on every deployment, router on or off)
  | "heuristic_ack"              // whole-message greeting / thanks / acknowledgement
  | "skip_subagent_session"      // ctx.sessionKey matched a skip.sessionPatterns entry
  | "skip_non_human_input"       // ctx.inputProvenance.kind is not external_user
  // 4.0.0 — policy / control plane
  | "policy_forced"              // one-shot client selection bypassed the router
  | "policy_off"                 // effective injection policy is "off"
  | "policy_tool"                // effective injection policy is "tool" (no auto-injection)
  | "policy_no_sources";         // no enabled source left after policy resolution

export interface RouterDecision {
  route: Route;
  reason: RouterReason;
  /** Confidence in [0, 1] when the classifier produced a score, else null. */
  score: number | null;
}
