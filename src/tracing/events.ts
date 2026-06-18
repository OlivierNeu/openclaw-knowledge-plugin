// Structured event emission for downstream observability tools.
//
// The plugin already runs inside an OpenClaw deployment that includes Opik
// (https://www.comet.com/docs/opik/) for tracing — but the plugin itself
// MUST NOT depend on the Opik SDK directly. Two reasons:
//
//   1. Deps. The plugin proudly ships with a single runtime dep (`pg`).
//      Adding `opik` would force every consumer to install it.
//   2. Coupling. Operators may swap Opik for LangFuse or pure OTLP. The
//      plugin should not care.
//
// Solution: emit structured JSON lines through OpenClaw's logger. The
// upstream gateway already forwards `logger.info(...)` to Opik (when
// configured) and to stdout in any case. A grep-friendly prefix
// (`[knowledge.event]`) lets a downstream scraper or Opik rule pick the
// records out without ambiguity.
//
// Privacy invariant: NO event in this module ever logs the raw user
// query, query excerpts, retrieved chunk content, OR ANY HASH OF THEM.
// We log metadata only (lengths, scores, counts, durations) plus the
// `runId` provided by the OpenClaw SDK when turn-level correlation is
// needed. The runId is non-query-derived by construction, so it cannot
// be reversed offline against a dictionary of likely prompts.
//
// The events module is intentionally tiny and synchronous — emitting a log
// line must NEVER throw, NEVER consume noticeable CPU, and NEVER hold the
// agent turn open.

import type { Route, RouterReason } from "../router/types.js";

/**
 * Minimal logger surface used by this module. Matches the relevant subset of
 * `PluginLogger` from the OpenClaw SDK so it can be unit-tested without
 * importing the full SDK type graph.
 */
export interface TracingLogger {
  info: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Marker prefix for every structured line emitted by this module. Pick a
 * value that is unlikely to clash with other plugins and stable across
 * versions — log scrapers and Opik rules depend on it.
 */
export const EVENT_PREFIX = "[knowledge.event]";

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

export interface RouterEvent {
  type: "router";
  route: Route;
  reason: RouterReason;
  score: number | null;
  queryLength: number;
  trigger?: string;
}

export interface PgvectorEvent {
  type: "pgvector";
  collections: string[];
  /**
   * Recall size of the vector search BEFORE the optional reranker.
   * `null` when {@link errored} is `true` and the value is therefore
   * not a meaningful "no hits" signal.
   */
  rawCount: number | null;
  rerankedCount: number | null;
  topScore: number | null;
  durationMs: number;
  /**
   * `true` when at least one configured collection's SQL search threw.
   * Surfaces failure modes (DB down, schema drift, network) that would
   * otherwise be indistinguishable from a 0-hit query in the event log.
   *
   * @since 3.2.3
   */
  errored: boolean;
  /**
   * `true` when these results came from TEST mode (canned data, no DB).
   * Omitted entirely in normal operation so production event lines are
   * byte-for-byte unchanged. Lets dashboards exclude synthetic traffic.
   *
   * @since 3.2.7
   */
  mock?: boolean;
}

export interface LightRAGEvent {
  type: "lightrag";
  mode: string;
  contextChars: number;
  truncatedChars: number;
  durationMs: number;
  /**
   * `true` when the LightRAG payload (post-truncation) is below
   * {@link LIGHTRAG_SPARSE_THRESHOLD_CHARS}, i.e. the graph essentially
   * returned nothing usable. Surfaces knowledge-coverage gaps in
   * dashboards without re-inspecting the raw context.
   *
   * @since 3.2.3
   */
  sparse: boolean;
  /**
   * `true` when this context came from TEST mode (canned data, no live
   * LightRAG server). Omitted in normal operation. @since 3.2.7
   */
  mock?: boolean;
}

/**
 * Threshold under which a LightRAG response is flagged `sparse`. Picked
 * empirically: 200 chars is roughly two short sentences — anything
 * below is too little to ground a non-trivial answer, so it is more
 * useful to surface the gap than to act on it.
 */
export const LIGHTRAG_SPARSE_THRESHOLD_CHARS = 200;

export interface JinaUsageEvent {
  type: "jina";
  endpoint: "classify" | "rerank";
  model: string;
  durationMs: number;
  inputCount: number;
}

export interface CooldownEvent {
  type: "cooldown";
  scope: "global" | "router" | "pgvector_reranker";
  consecutiveErrors: number;
}

/**
 * Emitted (at most once per 60-second window) when the plugin's
 * Jina RPM soft monitor observes the configured budget being exceeded.
 * Pure observability — does not block any call.
 *
 * @since 3.2.4
 */
export interface JinaRpmExceededEvent {
  type: "jina_rpm_exceeded";
  count: number;
  budget: number;
}

export type KnowledgeEvent =
  | RouterEvent
  | PgvectorEvent
  | LightRAGEvent
  | JinaUsageEvent
  | CooldownEvent
  | JinaRpmExceededEvent;

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Emit a structured event line through `logger.info`.
 *
 * Never throws. If JSON serialization or the logger itself fails (e.g.
 * upstream broke the contract), we silently swallow — the plugin must keep
 * working even if tracing breaks.
 */
export function emitEvent(logger: TracingLogger, event: KnowledgeEvent): void {
  try {
    const payload = JSON.stringify(event);
    logger.info(`${EVENT_PREFIX} ${payload}`);
  } catch {
    // intentional swallow — tracing must never crash the plugin
  }
}

/**
 * Optional debug-level emission of turn metadata for correlation.
 *
 * What goes into the log line:
 *   - `runId`: the OpenClaw SDK's runId for this agent turn (or
 *              `"unknown"` when the SDK did not supply one). This is the
 *              ONLY correlation key we expose — it is non-query-derived
 *              by construction, so it cannot be dictionary-recovered
 *              from the log line.
 *   - `qlen`:  character length of the query (a count, not content).
 *
 * What does NOT go in: any portion of the query text, AND no hash of it.
 * An earlier iteration of this plugin emitted `SHA-256(query)` truncated
 * to 12 hex chars under the assumption it was "non-reversible". Code
 * review (2026-05-23) correctly pointed out that for short or low-entropy
 * prompts (the hook accepts ≥ 3 chars), the hash is dictionary-recoverable
 * offline. We removed the hash entirely and rely on `runId` instead.
 *
 * Operators who want CONTENT correlation across turns must instrument
 * Opik / LangFuse at the SDK layer with their own keyed scheme (HMAC
 * with a deployment secret); the plugin will not do it for them.
 */
export function emitTurnMetadata(
  logger: TracingLogger,
  runId: string | undefined,
  queryLength: number,
): void {
  if (!logger.debug) return;
  try {
    const id = runId && runId.length > 0 ? runId : "unknown";
    logger.debug(`${EVENT_PREFIX} turn.metadata runId=${id} qlen=${queryLength}`);
  } catch {
    // swallow — tracing must never crash the plugin
  }
}
