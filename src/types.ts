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
  trigger?: "user" | "heartbeat" | "cron" | "memory" | "manual" | string;
  /** Channel-derived sender id. The plugin currently only uses `"cli"`. */
  messageProvider?: string;
  channelId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  /**
   * Host-classified origin of the turn's user-role input (OpenClaw >= 2026.9).
   * Absent when the producer did not classify it — absence does NOT prove a
   * human origin, but it is treated as "human" to preserve legacy behavior.
   * See upstream `src/sessions/input-provenance.ts`.
   *
   * @since 4.0.0
   */
  inputProvenance?: InputProvenanceLike;
  /**
   * Result-acceptance lifetime of THIS handler invocation (before_prompt_build
   * only, OpenClaw >= 2026.9). `assertActive()` throws once the runner stopped
   * awaiting the handler (timeout, error). Optional for SDK compatibility.
   *
   * @since 4.0.0
   */
  readonly hookInvocation?: Readonly<{ assertActive(): void }>;
}

/**
 * Structural subset of the upstream `InputProvenance` type. `kind` is one of
 * `external_user` | `inter_session` | `internal_system` on current hosts; the
 * type stays open (`string`) so an unknown future kind is handled explicitly.
 *
 * @since 4.0.0
 */
export interface InputProvenanceLike {
  kind?: string;
  sourceTool?: string;
  sourceChannel?: string;
  sourceSessionKey?: string;
  sourceRole?: string;
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

  /**
   * Provenance reporting toward chat frontends (provenance/v1 — see the
   * openclaw-webchat PROVENANCE_CONTRACT): "off" (default, no emission),
   * "metadata" (file names/collections/scores, no content), "full"
   * (plus the exact injected excerpts).
   *
   * @since 3.2.7
   */
  provenanceReport?: string;

  /**
   * TEST mode — mock both knowledge sources so the plugin can run in an
   * isolated test environment with NO live LightRAG server and NO
   * PostgreSQL/pgvector backend. The goal is to observe the plugin's real
   * impact on the agent's answers (the mocked context is genuinely
   * injected into the system prompt, so any downstream LLM trace —
   * e.g. LiteLLM → Langfuse — reflects it). Off by default; see the loud
   * registration warning. NEVER enable in production.
   *
   * @since 3.2.7
   */
  testMode?: TestModePluginConfig;

  // -------------------------------------------------------------------------
  // 4.0.0 — latency, cache-friendliness and control plane
  // -------------------------------------------------------------------------

  /** Where the knowledge block is injected. Default `prependContext`. @since 4.0.0 */
  injectionTarget?: InjectionTarget;
  /** Abort a LightRAG `/query` call after this many ms. Default 3500. @since 4.0.0 */
  lightragTimeoutMs?: number;
  /** Abort the pgvector path (Gemini embed + SQL) after this many ms. Default 3000. @since 4.0.0 */
  pgvectorTimeoutMs?: number;
  /**
   * Global per-turn retrieval budget (router + sources), in ms. When it
   * elapses the hook returns whatever sources already finished (partial
   * success, logged). Default 4500. @since 4.0.0
   */
  retrievalBudgetMs?: number;
  /**
   * Explicit `before_prompt_build` handler timeout registered with the host
   * (`api.on(..., { timeoutMs })`). Default `retrievalBudgetMs + 1500`.
   * @since 4.0.0
   */
  hookTimeoutMs?: number;
  /**
   * Per-route LightRAG query mode. Keys: `PGVECTOR_ONLY`, `LIGHTRAG_ONLY`,
   * `ALL`, `fallback` (ALL reached through a classifier fallback / low
   * confidence / error) and `tool` (on-demand `knowledge_search` calls).
   * @since 4.0.0
   */
  lightragQueryModeByRoute?: Partial<Record<LightRAGRouteKey, LightRAGQueryMode>>;
  /**
   * Compute `hl_keywords` / `ll_keywords` locally (FR+EN stopword filter) and
   * send them to LightRAG so it skips its own LLM keyword-extraction call on
   * `local` / `global` / `hybrid` / `mix` queries. Default false. @since 4.0.0
   */
  lightragLocalKeywords?: boolean;
  /** Non-human turn filters applied BEFORE any routing. @since 4.0.0 */
  skip?: SkipPluginConfig;
  /** Per-session result cache. @since 4.0.0 */
  cache?: CachePluginConfig;
  /** Export retrieval timings to Opik as traces. @since 4.0.0 */
  opik?: OpikPluginConfig;
  /**
   * Named knowledge sources. When omitted, sources are synthesized from the
   * legacy flat keys (`lightragUrl` → id `lightrag`, `collections` → id
   * `pgvector`). @since 4.0.0
   */
  sources?: Record<string, KnowledgeSourcePluginConfig>;
  /** Global default policy applied to every agent without its own entry. @since 4.0.0 */
  defaults?: KnowledgeAgentPolicyPluginConfig;
  /** Per-agent policy keyed by OpenClaw agent id. @since 4.0.0 */
  agents?: Record<string, KnowledgeAgentPolicyPluginConfig>;
  /**
   * `hybrid` injection only injects automatically when the router is
   * confident: a heuristic keyword hit, or a classifier hit whose score is
   * at least this value. Default 0.45. @since 4.0.0
   */
  hybridMinScore?: number;
  /** On-demand `knowledge_search` agent tool. @since 4.0.0 */
  tool?: ToolPluginConfig;
  /** Session overrides, `/knowledge` command and Gateway methods. @since 4.0.0 */
  controlPlane?: ControlPlanePluginConfig;
}

/** Route keys accepted by `lightragQueryModeByRoute`. @since 4.0.0 */
export type LightRAGRouteKey = "PGVECTOR_ONLY" | "LIGHTRAG_ONLY" | "ALL" | "fallback" | "tool";

/**
 * Injection policy:
 *   - `auto`   — retrieve and inject on every eligible turn (pre-4.0 behavior);
 *   - `tool`   — never inject automatically; the model uses `knowledge_search`;
 *   - `hybrid` — inject only when the router is confident the turn is a
 *                knowledge-base question, otherwise tool only;
 *   - `off`    — no injection and the tool refuses.
 *
 * @since 4.0.0
 */
export type InjectionPolicy = "auto" | "tool" | "hybrid" | "off";

/** @since 4.0.0 */
export interface SkipPluginConfig {
  /**
   * Substrings matched against `ctx.sessionKey`; a match skips retrieval.
   * Default `[":subagent:", ":active-memory:"]` (sessions_spawn children and
   * the active-memory recall sub-agent).
   */
  sessionPatterns?: string[];
  /** `ctx.trigger` values that skip retrieval. Default heartbeat, cron, memory, manual. */
  triggers?: string[];
  /**
   * Skip when `ctx.inputProvenance.kind` is present and is not
   * `external_user` (inter-session messages, subagent announce/settle,
   * internal system wakes). Default true.
   */
  nonHumanInput?: boolean;
  /**
   * `inputProvenance.sourceTool` values that are still retrieved even when
   * `nonHumanInput` would skip them. Default `[]`.
   */
  allowSourceTools?: string[];
  /**
   * Skip whole-message greetings / thanks / short acknowledgements (FR+EN,
   * anchored, bounded length) on every channel. Default true.
   */
  acknowledgements?: boolean;
}

/** @since 4.0.0 */
export interface CachePluginConfig {
  /** Default true. */
  enabled?: boolean;
  /** Entry time-to-live in ms. Default 600000 (10 min). */
  ttlMs?: number;
  /** Maximum number of cached source results. Default 200. */
  maxEntries?: number;
  /** Approximate maximum cache size in bytes (UTF-16 estimate). Default 8 MiB. */
  maxBytes?: number;
}

/**
 * Opik trace export (REST batch API). Content-free: durations, route and
 * policy metadata only — never the query, the retrieved text or the session key.
 * @since 4.0.0
 */
export interface OpikPluginConfig {
  /** Default false. */
  enabled?: boolean;
  /** Opik API base. Default `https://www.comet.com/opik/api` (Opik Cloud). */
  apiUrl?: string;
  /** API key; `${VAR}` supported. Default: the `OPIK_API_KEY` environment variable. */
  apiKey?: string;
  /** Opik Cloud workspace (`Comet-Workspace` header). */
  workspace?: string;
  /** Opik project receiving the traces. Default `openclaw-knowledge`. */
  projectName?: string;
  /** Also export turns skipped before routing (heartbeat, sub-agent, ack, policy). Default false. */
  includeSkipped?: boolean;
  /** Batch flush interval in ms. Default 5000. */
  flushIntervalMs?: number;
  /** Maximum traces buffered while Opik is unreachable (oldest dropped). Default 500. */
  maxQueue?: number;
}

/** @since 4.0.0 */
export interface ResolvedOpikConfig {
  enabled: boolean;
  apiUrl: string;
  apiKey: string;
  workspace: string;
  projectName: string;
  includeSkipped: boolean;
  flushIntervalMs: number;
  maxQueue: number;
}

/** @since 4.0.0 */
export interface KnowledgeSourcePluginConfig {
  type: "lightrag" | "pgvector";
  label?: string;
  description?: string;
  /** Default true. */
  enabled?: boolean;
  /** LightRAG base URL (falls back to the legacy `lightragUrl`). */
  url?: string;
  /** LightRAG API key (falls back to the legacy `lightragApiKey`). */
  apiKey?: string;
  /** pgvector collections (falls back to the legacy `collections`). */
  collections?: string[];
  /** Per-source LightRAG query mode (see precedence in the README). */
  queryMode?: LightRAGQueryMode;
  /** Per-source character budget (falls back to lightragMaxChars / maxInjectChars). */
  maxChars?: number;
}

/** @since 4.0.0 */
export interface KnowledgeAgentPolicyPluginConfig {
  injection?: InjectionPolicy;
  /**
   * Source ids used by default for this agent (clamped to `allowedSources`).
   * Only the default selection: it never narrows the allowlist (4.1.0).
   */
  sources?: string[];
  /**
   * Source ids a session / one-shot / tool call MAY select for this agent.
   * Defaults to the parent level's allowlist (`defaults.allowedSources`, else
   * every enabled source) — NOT to `sources` (changed in 4.1.0). Clients can
   * never reach a source outside this list.
   */
  allowedSources?: string[];
  /** pgvector top-K override. */
  topK?: number;
  /** LightRAG query mode override (wins over every route default). */
  lightragQueryMode?: LightRAGQueryMode;
  /** Whether session / one-shot overrides are honoured. Default true. */
  allowSessionOverrides?: boolean;
}

/** @since 4.0.0 */
export interface ToolPluginConfig {
  /** Register the `knowledge_search` tool. Default true (the tool is optional: allowlist it). */
  enabled?: boolean;
  /** Default top-K for tool calls. Default: the policy / global topK. */
  defaultTopK?: number;
  /** Upper bound on the `topK` argument. Default 20. */
  maxTopK?: number;
}

/** @since 4.0.0 */
export interface ControlPlanePluginConfig {
  /** Honour per-session overrides (session extension). Default true. */
  sessionOverrides?: boolean;
  /** A one-shot choice not consumed within this many ms is ignored. Default 600000. */
  oneShotTtlMs?: number;
  /** Register the `/knowledge` chat command. Default true. */
  command?: boolean;
  /** Register the Gateway methods and session actions. Default true. */
  gatewayMethods?: boolean;
}

/**
 * Raw TEST-mode configuration block (from
 * `plugins.entries.openclaw-knowledge.config.testMode`).
 *
 * @since 3.2.7
 */
export interface TestModePluginConfig {
  /**
   * Master switch. When `true`, BOTH sources are mocked: LightRAG returns
   * {@link lightragMockResponse} and pgvector returns
   * {@link pgvectorMockResults} — no network call, no DB pool. When the
   * mock is active a source counts as "enabled" even without its
   * credentials/URL, so the plugin still registers its hook. Default `false`.
   */
  enabled?: boolean;
  /**
   * Canned LightRAG context returned in test mode. The literal token
   * `{{query}}` (whitespace-tolerant) is substituted with the user's query
   * at runtime so operators can confirm the query reaches the source.
   * Defaults to a realistic synthetic knowledge-graph context (> 200 chars
   * so it is not flagged `sparse`).
   */
  lightragMockResponse?: string;
  /**
   * Canned pgvector hits returned in test mode. Each entry is normalized to
   * a full {@link PgvectorResult} (missing fields default to `null`, missing
   * `collection` to the first configured collection, missing `score` to
   * `0.8`) and the list is sorted by descending score to mirror the real
   * cosine-ranked path. Defaults to a small realistic synthetic set.
   */
  pgvectorMockResults?: PgvectorMockResult[];
  /**
   * Canned LightRAG source references returned in test mode. Each entry is either
   * a bare `file_path` string OR a rich `{ file_path, content[], reference_id? }`
   * object whose `content` is the list of retrieved chunks for that document — the
   * SAME shape real LightRAG returns with `include_chunk_content: true`. These flow
   * through provenance exactly like real references (since 3.2.8; per-document
   * `content` since 3.2.12), so a TEST deployment on a live gateway exercises the
   * full "which sources fed this answer + their content" panel for LightRAG,
   * mirroring what {@link pgvectorMockResults} enables for pgvector. Defaults to a
   * small synthetic set (with content) aligned with the default mock context. Set
   * to `[]` to mock LightRAG with no source attribution.
   *
   * @since 3.2.9 (rich content entries: 3.2.12)
   */
  lightragMockReferences?: Array<string | LightRAGMockReference>;
}

/** A rich mock LightRAG reference for test mode — mirrors the real response shape
 *  (file_path + the retrieved chunk `content` as a string[]). @since 3.2.12 */
export interface LightRAGMockReference {
  file_path: string;
  reference_id?: string;
  content?: string[];
}

/**
 * Ergonomic, partial shape an operator writes for a single mocked pgvector
 * hit. Only the fields worth asserting on are exposed; everything else is
 * filled with `null` by the resolver.
 *
 * @since 3.2.7
 */
export interface PgvectorMockResult {
  file_name?: string;
  text?: string;
  /** Cosine-like score in `[0, 1]`. Default `0.8`. */
  score?: number;
  /** Collection label. Defaults to the first configured collection. */
  collection?: string;
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

/** Router engines. `jina-classifier-parallel` @since 4.0.0. */
export type RouterMode = "heuristic" | "jina-classifier" | "jina-classifier-parallel";

export interface RouterPluginConfig {
  enabled?: boolean;
  mode?: RouterMode;
  /**
   * Timeout for the Jina classify call, in ms (also bounded by the global
   * retrieval budget). Default 1500. @since 4.0.0
   */
  timeoutMs?: number;
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

/** LightRAG query modes accepted by `/query` (`mix` since LightRAG 1.3; `bypass` is excluded on purpose — it skips retrieval). */
export type LightRAGQueryMode = "naive" | "local" | "global" | "hybrid" | "mix";

/**
 * One source reference from a LightRAG `/query` response. LightRAG (≥ 1.4.5)
 * returns a structured `references` array alongside the assembled `response`
 * context, each entry pointing at a source document, often with the per-document
 * `content` LightRAG retrieved for it.
 *
 * We capture the attribution (`reference_id`, `file_path`) AND, since 3.2.12, the
 * retrieved `content` (and `score` when present) so the chat frontend can show the
 * user the SOURCE MATERIAL the RAG pulled per document. Note the distinction: this
 * `content` is the RETRIEVED text per source — NOT the verbatim injected prompt (that
 * is the synthesized, `lightragMaxChars`-truncated `lightrag-context` blob). It is in
 * fact richer than the injection (it is not subject to that truncation), which is the
 * point — the user sees each document's relevant content even when the injected blob
 * was heavily truncated.
 *
 * @since 3.2.8 (content/score: 3.2.12)
 */
export interface LightRAGReference {
  /** LightRAG's opaque reference identifier (e.g. "5"), when provided. */
  reference_id?: string;
  /** Source document path/name LightRAG attributes this context to. */
  file_path: string;
  /** The retrieved source content for this document, when LightRAG provides it. */
  content?: string;
  /** A per-reference relevance score in [0, 1], when LightRAG provides it (not all
   *  versions do — surfaced defensively, never fabricated). */
  score?: number;
}

/**
 * Result of {@link queryLightRAG}: the assembled context blob plus the
 * structured source references. Pre-3.2.8 the function returned just the
 * context string; the object form carries the references needed for
 * provenance source-attribution without a second round-trip.
 *
 * @since 3.2.8
 */
export interface LightRAGQueryResult {
  context: string;
  references: LightRAGReference[];
}

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
  routerMode: RouterMode;
  /** Classifier call timeout in ms. @since 4.0.0 */
  routerTimeoutMs: number;
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

  /**
   * Provenance reporting level (provenance/v1). Default "off".
   *
   * @since 3.2.7
   */
  provenanceReport: "off" | "metadata" | "full";

  /**
   * TEST mode master switch (resolved from `testMode.enabled`). When `true`
   * both sources are mocked and no pg pool / network call is made.
   *
   * @since 3.2.7
   */
  testModeEnabled: boolean;
  /**
   * Resolved LightRAG canned context for test mode (defaults applied,
   * `{{query}}` still un-substituted — substitution happens per-turn).
   *
   * @since 3.2.7
   */
  lightragMockResponse: string;
  /**
   * Resolved pgvector canned hits for test mode (normalized to full
   * {@link PgvectorResult} shape and sorted by descending score).
   *
   * @since 3.2.7
   */
  pgvectorMockResults: PgvectorResult[];
  /**
   * Resolved LightRAG source references for test mode (normalized to
   * {@link LightRAGReference} from the configured `file_path` list).
   *
   * @since 3.2.9
   */
  lightragMockReferences: LightRAGReference[];

  // 4.0.0 --------------------------------------------------------------------
  injectionTarget: InjectionTarget;
  lightragTimeoutMs: number;
  pgvectorTimeoutMs: number;
  retrievalBudgetMs: number;
  hookTimeoutMs: number;
  /** Fully resolved per-route LightRAG mode map (explicit entries + defaults). */
  lightragQueryModeByRoute: Record<LightRAGRouteKey, LightRAGQueryMode>;
  /** Route keys explicitly configured by the operator (they beat per-source modes). */
  lightragQueryModeByRouteExplicit: LightRAGRouteKey[];
  /** True when the operator set the legacy `lightragQueryMode` explicitly. */
  lightragQueryModeExplicit: boolean;
  lightragLocalKeywords: boolean;
  skip: ResolvedSkipConfig;
  cache: ResolvedCacheConfig;
  opik: ResolvedOpikConfig;
  /** Enabled AND disabled named sources, in declaration order. */
  sources: ResolvedKnowledgeSource[];
  defaultPolicy: ResolvedAgentPolicy;
  agentPolicies: Record<string, ResolvedAgentPolicy>;
  hybridMinScore: number;
  tool: ResolvedToolConfig;
  controlPlane: ResolvedControlPlaneConfig;
  /** Non-fatal config problems (unknown source ids, invalid entries). */
  configWarnings: string[];
}

/** @since 4.0.0 */
export interface ResolvedSkipConfig {
  sessionPatterns: string[];
  triggers: string[];
  nonHumanInput: boolean;
  allowSourceTools: string[];
  acknowledgements: boolean;
}

/** @since 4.0.0 */
export interface ResolvedCacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
}

/** @since 4.0.0 */
export interface ResolvedKnowledgeSource {
  id: string;
  type: "lightrag" | "pgvector";
  label: string;
  description: string;
  /** Configured AND usable (credentials / URL present, or TEST mode). */
  enabled: boolean;
  /** LightRAG only. */
  url: string;
  /** LightRAG only. Never exposed through the control plane. */
  apiKey: string;
  /** pgvector only. */
  collections: string[];
  queryMode?: LightRAGQueryMode;
  maxChars: number;
  /** Synthesized from the legacy flat keys (keeps pre-4.0 section headers). */
  legacy: boolean;
}

/** @since 4.0.0 */
export interface ResolvedAgentPolicy {
  injection: InjectionPolicy;
  /** Default selection, always a subset of `allowedSources`. */
  sources: string[];
  allowedSources: string[];
  /**
   * Whether this level set `allowedSources` itself (`own`) or inherited its
   * parent's allowlist (`inherited`). @since 4.1.0
   */
  allowedOrigin: "own" | "inherited";
  topK?: number;
  lightragQueryMode?: LightRAGQueryMode;
  allowSessionOverrides: boolean;
}

/** @since 4.0.0 */
export interface ResolvedToolConfig {
  enabled: boolean;
  defaultTopK?: number;
  maxTopK: number;
}

/** @since 4.0.0 */
export interface ResolvedControlPlaneConfig {
  sessionOverrides: boolean;
  oneShotTtlMs: number;
  command: boolean;
  gatewayMethods: boolean;
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
  /**
   * Current request before history/context projection (OpenClaw >= 2026.9).
   * An explicit empty string means "no textual request" and must NOT fall
   * back to the history. Omitted on older harnesses.
   *
   * @since 4.0.0
   */
  currentUserMessage?: string;
  /** Stable native admission identity of the current request. @since 4.0.0 */
  currentUserMessageId?: string;
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
 * Where the knowledge block is injected. `prependContext` / `appendContext`
 * land on the CURRENT user message only (model submission; the transcript
 * keeps the raw user text), which keeps the system prompt and the whole
 * history prefix byte-stable across turns so provider prompt caching works.
 * `appendSystemContext` is the pre-4.0 behavior (system prompt suffix — the
 * system prompt changes every turn, which invalidates the cached prefix).
 *
 * @since 4.0.0
 */
export type InjectionTarget = "prependContext" | "appendContext" | "appendSystemContext";

/**
 * Return value honoured by OpenClaw when a `before_prompt_build` handler wants
 * to add the knowledge block to the turn. Exactly ONE of the three fields is
 * set, according to {@link InjectionTarget}.
 */
export interface BeforePromptBuildResult {
  prependContext?: string;
  appendContext?: string;
  appendSystemContext?: string;
}
