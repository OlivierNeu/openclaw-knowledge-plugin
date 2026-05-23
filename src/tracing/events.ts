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
  rawCount: number;
  rerankedCount: number | null;
  topScore: number | null;
  durationMs: number;
}

export interface LightRAGEvent {
  type: "lightrag";
  mode: string;
  contextChars: number;
  truncatedChars: number;
  durationMs: number;
}

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

export type KnowledgeEvent =
  | RouterEvent
  | PgvectorEvent
  | LightRAGEvent
  | JinaUsageEvent
  | CooldownEvent;

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
