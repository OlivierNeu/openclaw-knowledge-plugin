// Type definitions for the openclaw-knowledge plugin.
//
// Kept separate from the entry point so that tests and helper modules can
// import them without pulling in the full plugin registration code.

import type { RerankerModel } from "./jina/types.js";

// ---------------------------------------------------------------------------
// Plugin context exposed by the OpenClaw SDK on the before_prompt_build hook
// ---------------------------------------------------------------------------

/**
 * Subset of `PluginHookAgentContext` from the OpenClaw plugin SDK that this
 * plugin actually consumes. Declared locally to keep the test suite free of
 * SDK runtime imports.
 *
 * Fields beyond this subset (workspaceDir, modelProviderId, ...) are
 * deliberately omitted — the handler does not depend on them.
 *
 * @see https://github.com/openclaw/openclaw plugin-sdk types.d.ts
 */
export interface PluginHookAgentContext {
  /** What initiated this agent run. */
  trigger?: "user" | "heartbeat" | "cron" | "memory" | string;
  /** Channel-derived sender id. The plugin currently only uses `"cli"`. */
  messageProvider?: string;
  channelId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
}

// ---------------------------------------------------------------------------
// User-facing configuration (raw shape from plugins.entries.openclaw-knowledge.config)
// ---------------------------------------------------------------------------

/**
 * Runtime configuration as it appears in `plugins.entries.openclaw-knowledge.config`.
 * All fields are optional — defaults are applied in {@link resolveConfig}.
 */
export interface KnowledgePluginConfig {
  enabled?: boolean;

  // pgvector source
  geminiApiKey?: string;
  postgresUrl?: string;
  collections?: string[];
  topK?: number;
  scoreThreshold?: number;
  maxInjectChars?: number;
  pgvectorEnabled?: boolean;

  // LightRAG source
  lightragUrl?: string;
  lightragApiKey?: string;
  lightragQueryMode?: LightRAGQueryMode;
  lightragMaxChars?: number;
  lightragEnabled?: boolean;

  // Jina-powered enhancements (router + pgvector reranker). All sub-fields
  // are optional; omitting `jina` entirely preserves pre-3.2.0 behavior.
  jina?: JinaPluginConfig;
}

export interface JinaPluginConfig {
  /** Jina API key. Required for `router.mode=jina-classifier` or `pgvectorReranker.enabled`. Supports `${ENV_VAR}` substitution. */
  apiKey?: string;
  router?: RouterPluginConfig;
  pgvectorReranker?: PgvectorRerankerPluginConfig;
  /**
   * Soft RPM budget for ALL outbound Jina calls (router + reranker
   * combined). When the sliding 60-second window exceeds this number,
   * a `jina_rpm_exceeded` event is emitted (at most once per window)
   * and a warning is logged. **The call is NEVER blocked** — the
   * existing 429 cooldown breaker is the hard backstop.
   *
   * Default: 60. Set well below the Jina free-tier ceiling (100 RPM)
   * to leave headroom for a shared key (e.g. plugin + Hindsight).
   *
   * @since 3.2.4
   */
  rpmBudget?: number;
}

export interface RouterPluginConfig {
  enabled?: boolean;
  mode?: "heuristic" | "jina-classifier";
  /**
   * Optional pre-trained Jina classifier_id. When set, the router calls
   * `/v1/classify` with this ID (few-shot mode). Train it out-of-band via
   * `POST /v1/train` — the plugin does NOT implement training.
   */
  classifierId?: string;
  /**
   * Minimum classifier confidence (cosine similarity in `[0, 1]`) required
   * to trust a classifier prediction. When the top score is below this
   * threshold, the router fails open to `ALL` rather than acting on a
   * noisy decision. Default: `0.35`.
   */
  minConfidence?: number;
}

export interface PgvectorRerankerPluginConfig {
  enabled?: boolean;
  /** Reranker model. Default: `jina-reranker-v2-base-multilingual` (best FR coverage). */
  model?: RerankerModel;
  /** Cap on results returned post-rerank. Default: `5`. */
  topN?: number;
  /**
   * Maximum number of candidate documents submitted to Jina per call.
   * Pgvector recall is typically broad (20-50 hits) but only the top
   * 10-15 are worth reranking. Trimming the tail saves Jina tokens
   * linearly. Default: `20`. Set to `0` to disable the cap.
   *
   * @since 3.2.4
   */
  candidatePoolMax?: number;
  /**
   * Per-candidate text length cap (characters) before submission to
   * Jina. The first ~2000 chars carry most of the relevance signal;
   * longer chunks (transcripts, books) waste tokens on context the
   * cross-encoder gets little additional signal from. Default: `2000`.
   * Set to `0` to disable the truncation.
   *
   * @since 3.2.4
   */
  maxCharsPerDoc?: number;
}

export type LightRAGQueryMode = "naive" | "local" | "global" | "hybrid";

// ---------------------------------------------------------------------------
// Resolved configuration (after defaults + env substitution)
// ---------------------------------------------------------------------------

/**
 * Fully resolved plugin configuration after defaults, env substitution, and
 * derivation of the pgvector/lightrag enabled flags from presence of secrets.
 */
export interface ResolvedKnowledgeConfig {
  enabled: boolean;

  // pgvector
  geminiApiKey: string;
  postgresUrl: string;
  collections: string[];
  topK: number;
  scoreThreshold: number;
  maxInjectChars: number;
  pgvectorEnabled: boolean;

  // LightRAG
  lightragUrl: string;
  lightragApiKey: string;
  lightragQueryMode: LightRAGQueryMode;
  lightragMaxChars: number;
  lightragEnabled: boolean;

  // Jina shared
  jinaApiKey: string;
  /**
   * Soft RPM budget for ALL outbound Jina calls. Default: 60.
   * `0` disables the monitor entirely.
   *
   * @since 3.2.4
   */
  jinaRpmBudget: number;

  // Router
  routerEnabled: boolean;
  routerMode: "heuristic" | "jina-classifier";
  routerClassifierId: string;
  /**
   * Minimum classifier confidence (cosine similarity in `[0, 1]`) required
   * to act on a classifier prediction. Below this threshold the router
   * fails open to `ALL`. See `RouterConfig.minConfidence` for rationale.
   */
  routerMinConfidence: number;

  // Pgvector reranker
  pgvectorRerankerEnabled: boolean;
  pgvectorRerankerModel: RerankerModel;
  pgvectorRerankerTopN: number;
  /**
   * Cap on the number of candidates submitted to Jina /v1/rerank. `0`
   * disables the cap (legacy v3.2.3 behavior). Default: `20`.
   *
   * @since 3.2.4
   */
  pgvectorRerankerCandidatePoolMax: number;
  /**
   * Per-candidate text truncation length in characters. `0` disables
   * truncation. Default: `2000`.
   *
   * @since 3.2.4
   */
  pgvectorRerankerMaxCharsPerDoc: number;
}

// ---------------------------------------------------------------------------
// Pgvector wire shapes
// ---------------------------------------------------------------------------

/**
 * One search hit from the PostgreSQL `knowledge_vectors` table, after score
 * parsing and filtering.
 */
export interface PgvectorResult {
  collection: string;
  score: number;
  file_name: string | null;
  mime_type: string | null;
  text: string | null;
  file_id: string | null;
  source: string | null;
  owner: string | null;
  chunk_index: number | null;
  total_chunks: number | null;
  timestamp_start: string | null;
  timestamp_end: string | null;
}

/**
 * Minimal `pg.Pool` surface that {@link searchCollection} actually uses.
 * Declared locally so helpers can be unit-tested without a real database
 * and without pulling `@types/pg` into the test graph.
 */
export interface PgPoolLike {
  query(sql: string, params: unknown[]): Promise<{ rows: PgvectorRow[] }>;
}

/**
 * Raw row shape returned by the pgvector SQL query. `score` comes back as a
 * string because pg returns numeric values as strings by default.
 */
export interface PgvectorRow {
  file_name?: string | null;
  mime_type?: string | null;
  text?: string | null;
  file_id?: string | null;
  source?: string | null;
  owner?: string | null;
  chunk_index?: number | null;
  total_chunks?: number | null;
  timestamp_start?: string | null;
  timestamp_end?: string | null;
  embedded_at?: string | null;
  score: string;
}

// ---------------------------------------------------------------------------
// Hook event shape (consumed by the handler factory)
// ---------------------------------------------------------------------------

/**
 * Shape of the `before_prompt_build` event payload as consumed by this plugin.
 *
 * As of v3.2.1, `prompt` is the PRIMARY source for the user query — it is
 * the raw user text surfaced by the SDK, distinct from `messages` which may
 * aggregate the full conversation window (with summaries, system prompt
 * fragments, etc.). The handler reads `prompt` first; `messages` remains
 * as a legacy fallback for SDK versions that do not populate it.
 */
export interface BeforePromptBuildEvent {
  /** Raw user prompt for this turn. SDK >= 2026.5.0. */
  prompt?: string;
  messages?: PromptMessage[];
}

export interface PromptMessage {
  role?: string;
  content?: string | PromptContentPart[];
}

export interface PromptContentPart {
  type?: string;
  text?: string;
}

/**
 * Return value honoured by OpenClaw when a `before_prompt_build` handler wants
 * to append extra text to the agent's system prompt.
 */
export interface BeforePromptBuildResult {
  appendSystemContext: string;
}
