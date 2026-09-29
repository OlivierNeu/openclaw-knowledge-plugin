// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.

import { DEFAULT_RPM_BUDGET } from "./jina/rate-limit.js";
import type { RerankerModel } from "./jina/types.js";
import { normalizeReferenceContent } from "./lightrag.js";
import { resolveProvenanceLevel } from "./provenance.js";
import { DEFAULT_MIN_CONFIDENCE } from "./router/index.js";
import type {
  CachePluginConfig,
  ControlPlanePluginConfig,
  InjectionPolicy,
  InjectionTarget,
  JinaPluginConfig,
  KnowledgeAgentPolicyPluginConfig,
  KnowledgePluginConfig,
  KnowledgeSourcePluginConfig,
  LightRAGMockReference,
  LightRAGQueryMode,
  LightRAGReference,
  LightRAGRouteKey,
  OpikPluginConfig,
  PgvectorMockResult,
  PgvectorRerankerPluginConfig,
  PgvectorResult,
  ResolvedAgentPolicy,
  ResolvedCacheConfig,
  ResolvedControlPlaneConfig,
  ResolvedKnowledgeConfig,
  ResolvedKnowledgeSource,
  ResolvedOpikConfig,
  ResolvedSkipConfig,
  ResolvedToolConfig,
  RouterMode,
  RouterPluginConfig,
  SkipPluginConfig,
  TestModePluginConfig,
  ToolPluginConfig,
} from "./types.js";

/**
 * Expand `${VAR_NAME}` patterns in a config string against `process.env`.
 * Non-string values are returned untouched so the helper can be used on any
 * raw config field without type narrowing at the call site. Missing env vars
 * become empty strings to avoid leaking `undefined` into downstream code.
 */
export function resolveEnv<T>(value: T): T {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    return process.env[name] ?? "";
  }) as unknown as T;
}

/** Clamp a finite number into `[0, 1]`. Non-finite values fall back to `0`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

const DEFAULT_POSTGRES_URL = "postgresql://openclaw:@postgresql:5432/knowledge";
const DEFAULT_COLLECTIONS = ["knowledge_default"];
const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_THRESHOLD = 0.3;
const DEFAULT_MAX_INJECT_CHARS = 4000;
const DEFAULT_LIGHTRAG_MODE: LightRAGQueryMode = "hybrid";
const DEFAULT_LIGHTRAG_MAX_CHARS = 4000;

const DEFAULT_ROUTER_MODE: RouterMode = "heuristic";
const ROUTER_MODES: readonly RouterMode[] = [
  "heuristic",
  "jina-classifier",
  "jina-classifier-parallel",
];
const DEFAULT_ROUTER_TIMEOUT_MS = 1500;

// 4.0.0 — latency budgets. Calibrated for a 2-core NAS: LightRAG `hybrid`
// with LLM keyword extraction routinely takes 5-20 s through free
// OpenRouter models; a turn must not wait for it.
const DEFAULT_LIGHTRAG_TIMEOUT_MS = 3500;
const DEFAULT_PGVECTOR_TIMEOUT_MS = 3000;
const DEFAULT_RETRIEVAL_BUDGET_MS = 4500;
const HOOK_TIMEOUT_MARGIN_MS = 1500;
const MAX_TIMEOUT_MS = 120_000;

const DEFAULT_INJECTION_TARGET: InjectionTarget = "prependContext";
const INJECTION_TARGETS: readonly InjectionTarget[] = [
  "prependContext",
  "appendContext",
  "appendSystemContext",
];

export const INJECTION_POLICIES: readonly InjectionPolicy[] = ["auto", "tool", "hybrid", "off"];
export const LIGHTRAG_QUERY_MODES: readonly LightRAGQueryMode[] = [
  "naive",
  "local",
  "global",
  "hybrid",
  "mix",
];
export const LIGHTRAG_ROUTE_KEYS: readonly LightRAGRouteKey[] = [
  "PGVECTOR_ONLY",
  "LIGHTRAG_ONLY",
  "ALL",
  "fallback",
  "tool",
];

/**
 * Built-in per-route LightRAG modes, used when neither the legacy
 * `lightragQueryMode` nor `lightragQueryModeByRoute` says otherwise.
 * `naive` skips LightRAG's LLM keyword extraction (pure chunk vector search),
 * so it is the default for simple lookups and on-demand tool calls; graph
 * questions keep `hybrid`.
 */
const DEFAULT_LIGHTRAG_MODE_BY_ROUTE: Record<LightRAGRouteKey, LightRAGQueryMode> = {
  PGVECTOR_ONLY: "naive",
  LIGHTRAG_ONLY: "hybrid",
  ALL: "hybrid",
  fallback: "hybrid",
  tool: "naive",
};

export const DEFAULT_SKIP_SESSION_PATTERNS = [":subagent:", ":active-memory:"];
export const DEFAULT_SKIP_TRIGGERS = ["heartbeat", "cron", "memory", "manual"];

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 200;
const DEFAULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

const DEFAULT_HYBRID_MIN_SCORE = 0.45;
const DEFAULT_TOOL_MAX_TOP_K = 20;
const DEFAULT_ONE_SHOT_TTL_MS = 10 * 60 * 1000;

/** Source / agent ids: short, URL- and log-safe. */
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const LEGACY_LIGHTRAG_SOURCE_ID = "lightrag";
export const LEGACY_PGVECTOR_SOURCE_ID = "pgvector";
// The router's confidence floor is owned by `src/router/index.ts`
// (`DEFAULT_MIN_CONFIDENCE`). Re-export of a local alias would create
// two sources of truth — we import the single constant instead.
//
// Empirical observation in production traces (v3.2.1 deployment): Jina v3
// zero-shot scores cluster at 0.25-0.27 when no label actually matches
// the query, then resolve to a noisy `NONE` decision that wrongly
// blocks retrieval. A floor of 0.35 catches that noise band while
// staying below typical hit scores (≈ 0.40-0.65).
const DEFAULT_RERANKER_MODEL: RerankerModel = "jina-reranker-v2-base-multilingual";
const DEFAULT_RERANKER_TOP_N = 5;
// 3.2.4 — payload-trimming defaults. Empirically calibrated from the
// production Jina dashboard: 20 candidates × 2000 chars
// fits in ~10K tokens (well below jina-reranker-v2's 8K context window
// once the query is added) while preserving the top-precision band.
const DEFAULT_RERANKER_CANDIDATE_POOL_MAX = 20;
const DEFAULT_RERANKER_MAX_CHARS_PER_DOC = 2000;

// 3.2.7 — TEST mode defaults. The canned LightRAG context is deliberately
// > 200 chars so it is not flagged `sparse`, and embeds a distinctive,
// citable fact (`HX-2026-0042`) so an operator can confirm — from the
// agent's answer alone — that the injected context actually reached the
// LLM. `{{query}}` is substituted per-turn (see renderMockResponse) to make
// it obvious the query travels through the source.
const DEFAULT_LIGHTRAG_MOCK_RESPONSE = [
  "[Mock LightRAG context — TEST MODE]",
  'Knowledge-graph context assembled for the query "{{query}}":',
  "",
  "Entity: Projet Hélios — pilot knowledge-base integration project.",
  'Relation: Projet Hélios → owned_by → "équipe Plateforme".',
  'Relation: Projet Hélios → status → "active since 2026-02-14".',
  'Entity: Document "guide-deploiement-helios.md" — describes the rollout plan.',
  "Fact: The Hélios reference identifier is HX-2026-0042.",
  "",
  "This is synthetic data injected by the plugin's TEST mode to validate",
  "context injection without a live LightRAG server.",
].join("\n");

// Mirrors the shape pgvector would return for the same synthetic project,
// so the injected `Document Search Results` block looks production-realistic.
const DEFAULT_PGVECTOR_MOCK_RESULTS: PgvectorMockResult[] = [
  {
    file_name: "guide-deploiement-helios.md",
    score: 0.87,
    text:
      "Le déploiement du Projet Hélios suit trois phases : préparation, " +
      "bascule, validation. Identifiant de référence : HX-2026-0042.",
  },
  {
    file_name: "faq-helios.md",
    score: 0.72,
    text:
      "Q : Qui pilote le Projet Hélios ? R : l'équipe Plateforme, active " +
      "depuis le 2026-02-14.",
  },
];

const DEFAULT_MOCK_SCORE = 0.8;
const DEFAULT_MOCK_COLLECTION = "knowledge_test";

// 3.2.9 — default LightRAG mock source references. MIRRORS the REAL production shape:
// `file_path` is the gdrive retrieval key (`gdrive/<hash>`, NOT a readable name), and the
// chunk `content` begins with the ingestion pipeline's `--- Document Metadata --- File
// Name: <name> …` header — so a TEST deployment exercises the full path end-to-end: the
// per-document excerpt (3.2.12) AND the readable `title` extracted from the header while
// `file_name` stays the gdrive id (3.2.13). content is a string[] like real LightRAG with
// `include_chunk_content: true`.
const DEFAULT_LIGHTRAG_MOCK_REFERENCES: LightRAGMockReference[] = [
  {
    file_path: "gdrive/a1b2c3d4e5f600112233445566778899",
    reference_id: "1",
    content: [
      "--- Document Metadata ---\nFile Name: Guide de deploiement Helios.md\nSource: Google Drive\nFile ID: 1AbCdEfGhIjKlMnOpQrStUvWxYz\n---\n\nLe deploiement d'Helios se fait en trois etapes : preparation de l'environnement, application des migrations, puis bascule du trafic.",
      "Chaque etape est reversible ; un rollback restaure l'etat precedent sans perte de donnees.",
    ],
  },
  {
    file_path: "gdrive/99887766554433221100ffeeddccbbaa",
    reference_id: "2",
    content: [
      "--- Document Metadata ---\nFile Name: FAQ Helios.md\nSource: Google Drive\nFile ID: 2ZyXwVuTsRqPoNmLkJiHgFeDcBa\n---\n\nQ : Helios supporte-t-il le multi-tenant ? R : Oui, chaque tenant est isole par schema, sans partage de donnees.",
    ],
  },
];

/**
 * Apply defaults and env substitution to the raw plugin config. A source is
 * enabled when its credentials are present, unless the user explicitly toggles
 * `pgvectorEnabled`/`lightragEnabled` off.
 *
 * Jina-derived features (router + pgvector reranker) follow the same
 * "default to off" discipline: nothing activates without an explicit opt-in,
 * so pre-3.2.0 configs continue to work identically.
 */
export function resolveConfig(
  cfg: KnowledgePluginConfig = {},
): ResolvedKnowledgeConfig {
  const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
  const postgresUrl = resolveEnv(cfg.postgresUrl ?? DEFAULT_POSTGRES_URL);
  const lightragUrl = resolveEnv(cfg.lightragUrl ?? "");
  const lightragApiKey = resolveEnv(cfg.lightragApiKey ?? "");

  const jina = (cfg.jina ?? {}) as JinaPluginConfig;
  const router = (jina.router ?? {}) as RouterPluginConfig;
  const reranker = (jina.pgvectorReranker ?? {}) as PgvectorRerankerPluginConfig;
  const jinaApiKey = resolveEnv(jina.apiKey ?? "");
  const routerClassifierId = resolveEnv(router.classifierId ?? "");

  const collections = cfg.collections ?? DEFAULT_COLLECTIONS;

  // TEST mode — mocked sources for infra-less environments. When active, a
  // source is "enabled" even without its credentials/URL so the hook still
  // registers; the explicit `pgvectorEnabled`/`lightragEnabled: false`
  // toggles still win (first conjunct) so an operator can mock a single
  // source in isolation.
  const test = (cfg.testMode ?? {}) as TestModePluginConfig;
  const testModeEnabled = test.enabled === true;

  const pgvectorEnabled =
    cfg.pgvectorEnabled !== false && (Boolean(geminiApiKey) || testModeEnabled);
  const lightragEnabled =
    cfg.lightragEnabled !== false && (Boolean(lightragUrl) || testModeEnabled);
  const topK = cfg.topK ?? DEFAULT_TOP_K;
  const maxInjectChars = cfg.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS;
  const lightragMaxChars = cfg.lightragMaxChars ?? DEFAULT_LIGHTRAG_MAX_CHARS;
  const lightragQueryMode = isLightRAGMode(cfg.lightragQueryMode)
    ? cfg.lightragQueryMode
    : DEFAULT_LIGHTRAG_MODE;

  const configWarnings: string[] = [];
  const sources = resolveSources(cfg, {
    geminiApiKey,
    lightragUrl,
    lightragApiKey,
    collections,
    pgvectorEnabled,
    lightragEnabled,
    maxInjectChars,
    lightragMaxChars,
    testModeEnabled,
    warnings: configWarnings,
  });
  const enabledIds = sources.filter((src) => src.enabled).map((src) => src.id);
  const knownIds = new Set(sources.map((src) => src.id));
  const defaultPolicy = resolvePolicy(
    cfg.defaults,
    {
      injection: "auto",
      sources: enabledIds,
      allowedSources: enabledIds,
      allowedOrigin: "inherited",
      allowSessionOverrides: true,
    },
    knownIds,
    enabledIds,
    "defaults",
    configWarnings,
  );
  const agentPolicies: Record<string, ResolvedAgentPolicy> = {};
  if (cfg.agents && typeof cfg.agents === "object") {
    for (const [agentId, raw] of Object.entries(cfg.agents)) {
      if (!SOURCE_ID_PATTERN.test(agentId) || !raw || typeof raw !== "object") {
        configWarnings.push(`agents.${agentId}: invalid agent id or entry — ignored`);
        continue;
      }
      agentPolicies[agentId] = resolvePolicy(
        raw,
        defaultPolicy,
        knownIds,
        enabledIds,
        `agents.${agentId}`,
        configWarnings,
      );
    }
  }

  const retrievalBudgetMs = clampTimeout(cfg.retrievalBudgetMs, DEFAULT_RETRIEVAL_BUDGET_MS);
  // The host drops a hook result that arrives after `hookTimeoutMs`: below the
  // retrieval budget, slow-but-successful turns would be computed for nothing.
  const minHookTimeoutMs = Math.min(retrievalBudgetMs + HOOK_TIMEOUT_MARGIN_MS, MAX_TIMEOUT_MS);
  let hookTimeoutMs = clampTimeout(cfg.hookTimeoutMs, minHookTimeoutMs);
  if (hookTimeoutMs < minHookTimeoutMs) {
    configWarnings.push(
      `hookTimeoutMs=${hookTimeoutMs} is below retrievalBudgetMs + ${HOOK_TIMEOUT_MARGIN_MS} — raised to ${minHookTimeoutMs}`,
    );
    hookTimeoutMs = minHookTimeoutMs;
  }
  const modeByRoute = resolveModeByRoute(cfg);

  return {
    enabled: cfg.enabled !== false,
    geminiApiKey,
    postgresUrl,
    collections,
    topK,
    scoreThreshold: cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    maxInjectChars,
    // Legacy aggregate flags: true when at least one ENABLED named source of
    // that type exists (identical to the pre-4.0 derivation when `sources`
    // is not configured).
    pgvectorEnabled: sources.some((src) => src.enabled && src.type === "pgvector"),
    lightragUrl,
    lightragApiKey,
    lightragQueryMode,
    lightragMaxChars,
    lightragEnabled: sources.some((src) => src.enabled && src.type === "lightrag"),

    // Jina shared key (used by router and/or reranker)
    jinaApiKey,
    // 3.2.4 — soft RPM budget. 0 disables the monitor entirely.
    jinaRpmBudget: clampNonNegInt(jina.rpmBudget ?? DEFAULT_RPM_BUDGET),

    // Router — disabled by default, even with a Jina key present, so
    // operators must opt in explicitly. "heuristic" mode is the safest
    // entry point: zero cost, deterministic.
    routerEnabled: router.enabled === true,
    routerMode: ROUTER_MODES.includes(router.mode as RouterMode)
      ? (router.mode as RouterMode)
      : DEFAULT_ROUTER_MODE,
    routerTimeoutMs: clampTimeout(router.timeoutMs, DEFAULT_ROUTER_TIMEOUT_MS),
    routerClassifierId,
    // Clamp to [0, 1] to keep the classifier comparison well-defined
    // even when a misconfigured value sneaks past the JSON schema.
    routerMinConfidence: clamp01(
      router.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    ),

    // Pgvector reranker — disabled by default. Requires both the toggle
    // and a Jina key to actually activate at runtime (the handler checks
    // this combination before calling).
    pgvectorRerankerEnabled: reranker.enabled === true && Boolean(jinaApiKey),
    pgvectorRerankerModel: reranker.model ?? DEFAULT_RERANKER_MODEL,
    pgvectorRerankerTopN: reranker.topN ?? DEFAULT_RERANKER_TOP_N,
    // 3.2.4 — payload-size guards. `null`/`undefined` user input falls
    // back to the production-tuned defaults; an explicit `0` disables
    // the corresponding cap (legacy v3.2.3 behavior).
    pgvectorRerankerCandidatePoolMax: clampNonNegInt(
      reranker.candidatePoolMax ?? DEFAULT_RERANKER_CANDIDATE_POOL_MAX,
    ),
    pgvectorRerankerMaxCharsPerDoc: clampNonNegInt(
      reranker.maxCharsPerDoc ?? DEFAULT_RERANKER_MAX_CHARS_PER_DOC,
    ),

    // 3.2.7 — provenance reporting toward chat frontends. Off-list values
    // (typos, future levels) normalize to "off": a misconfiguration must
    // never silently leak content.
    provenanceReport: resolveProvenanceLevel(cfg.provenanceReport),

    // 3.2.7 — TEST mode. Mocks resolve unconditionally (cheap) so the
    // handler can read them without re-deriving defaults; they are only
    // consumed when `testModeEnabled` is true.
    testModeEnabled,
    lightragMockResponse:
      typeof test.lightragMockResponse === "string"
        ? test.lightragMockResponse
        : DEFAULT_LIGHTRAG_MOCK_RESPONSE,
    pgvectorMockResults: toPgvectorMockResults(
      test.pgvectorMockResults ?? DEFAULT_PGVECTOR_MOCK_RESULTS,
      collections[0] ?? DEFAULT_MOCK_COLLECTION,
    ),
    lightragMockReferences: toLightRAGMockReferences(
      test.lightragMockReferences ?? DEFAULT_LIGHTRAG_MOCK_REFERENCES,
    ),

    // 4.0.0
    injectionTarget: INJECTION_TARGETS.includes(cfg.injectionTarget as InjectionTarget)
      ? (cfg.injectionTarget as InjectionTarget)
      : DEFAULT_INJECTION_TARGET,
    lightragTimeoutMs: clampTimeout(cfg.lightragTimeoutMs, DEFAULT_LIGHTRAG_TIMEOUT_MS),
    pgvectorTimeoutMs: clampTimeout(cfg.pgvectorTimeoutMs, DEFAULT_PGVECTOR_TIMEOUT_MS),
    retrievalBudgetMs,
    hookTimeoutMs,
    lightragQueryModeByRoute: modeByRoute.modes,
    lightragQueryModeByRouteExplicit: modeByRoute.explicit,
    lightragQueryModeExplicit: isLightRAGMode(cfg.lightragQueryMode),
    lightragLocalKeywords: cfg.lightragLocalKeywords === true,
    skip: resolveSkip(cfg.skip),
    cache: resolveCache(cfg.cache),
    opik: resolveOpik(cfg.opik, configWarnings),
    sources,
    defaultPolicy,
    agentPolicies,
    hybridMinScore: clamp01(
      typeof cfg.hybridMinScore === "number" ? cfg.hybridMinScore : DEFAULT_HYBRID_MIN_SCORE,
    ),
    tool: resolveTool(cfg.tool),
    controlPlane: resolveControlPlane(cfg.controlPlane),
    configWarnings,
  };
}

// ---------------------------------------------------------------------------
// 4.0.0 resolvers
// ---------------------------------------------------------------------------

export function isLightRAGMode(value: unknown): value is LightRAGQueryMode {
  return LIGHTRAG_QUERY_MODES.includes(value as LightRAGQueryMode);
}

export function isInjectionPolicy(value: unknown): value is InjectionPolicy {
  return INJECTION_POLICIES.includes(value as InjectionPolicy);
}

/** Positive, bounded integer timeout; anything else falls back to `fallback`. */
function clampTimeout(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function positiveIntOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function resolveModeByRoute(cfg: KnowledgePluginConfig): {
  modes: Record<LightRAGRouteKey, LightRAGQueryMode>;
  explicit: LightRAGRouteKey[];
} {
  // The legacy global mode, when explicitly set, overrides every built-in
  // route default (pre-4.0 semantics: one mode for every query).
  const base: Record<LightRAGRouteKey, LightRAGQueryMode> = isLightRAGMode(cfg.lightragQueryMode)
    ? {
        PGVECTOR_ONLY: cfg.lightragQueryMode,
        LIGHTRAG_ONLY: cfg.lightragQueryMode,
        ALL: cfg.lightragQueryMode,
        fallback: cfg.lightragQueryMode,
        tool: cfg.lightragQueryMode,
      }
    : { ...DEFAULT_LIGHTRAG_MODE_BY_ROUTE };
  const explicit: LightRAGRouteKey[] = [];
  const raw = cfg.lightragQueryModeByRoute;
  if (raw && typeof raw === "object") {
    for (const key of LIGHTRAG_ROUTE_KEYS) {
      const mode = (raw as Record<string, unknown>)[key];
      if (isLightRAGMode(mode)) {
        base[key] = mode;
        explicit.push(key);
      }
    }
  }
  return { modes: base, explicit };
}

function resolveSkip(raw: SkipPluginConfig | undefined): ResolvedSkipConfig {
  const skip = raw ?? {};
  return {
    sessionPatterns: stringList(skip.sessionPatterns) ?? [...DEFAULT_SKIP_SESSION_PATTERNS],
    triggers: stringList(skip.triggers) ?? [...DEFAULT_SKIP_TRIGGERS],
    nonHumanInput: skip.nonHumanInput !== false,
    allowSourceTools: stringList(skip.allowSourceTools) ?? [],
    acknowledgements: skip.acknowledgements !== false,
  };
}

function resolveCache(raw: CachePluginConfig | undefined): ResolvedCacheConfig {
  const cache = raw ?? {};
  return {
    enabled: cache.enabled !== false,
    ttlMs: positiveIntOr(cache.ttlMs, DEFAULT_CACHE_TTL_MS),
    maxEntries: positiveIntOr(cache.maxEntries, DEFAULT_CACHE_MAX_ENTRIES),
    maxBytes: positiveIntOr(cache.maxBytes, DEFAULT_CACHE_MAX_BYTES),
  };
}

const DEFAULT_OPIK_API_URL = "https://www.comet.com/opik/api";
const DEFAULT_OPIK_PROJECT = "openclaw-knowledge";
const DEFAULT_OPIK_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_OPIK_MAX_QUEUE = 500;

function resolveOpik(raw: OpikPluginConfig | undefined, warnings: string[]): ResolvedOpikConfig {
  const opik = raw ?? {};
  const apiKey = resolveEnv(opik.apiKey ?? "") || process.env.OPIK_API_KEY || "";
  const apiUrl = (resolveEnv(opik.apiUrl ?? "") || DEFAULT_OPIK_API_URL).replace(/\/+$/u, "");
  const requested = opik.enabled === true;
  if (requested && !apiKey) {
    warnings.push("opik.enabled but no API key (opik.apiKey / OPIK_API_KEY) — export disabled");
  }
  return {
    enabled: requested && Boolean(apiKey),
    apiUrl,
    apiKey,
    workspace: resolveEnv(opik.workspace ?? ""),
    projectName: resolveEnv(opik.projectName ?? "") || DEFAULT_OPIK_PROJECT,
    includeSkipped: opik.includeSkipped === true,
    flushIntervalMs: Math.max(1000, positiveIntOr(opik.flushIntervalMs, DEFAULT_OPIK_FLUSH_INTERVAL_MS)),
    maxQueue: Math.max(1, positiveIntOr(opik.maxQueue, DEFAULT_OPIK_MAX_QUEUE)),
  };
}

function resolveTool(raw: ToolPluginConfig | undefined): ResolvedToolConfig {
  const tool = raw ?? {};
  const maxTopK = Math.max(1, positiveIntOr(tool.maxTopK, DEFAULT_TOOL_MAX_TOP_K));
  const defaultTopK =
    typeof tool.defaultTopK === "number" && tool.defaultTopK >= 1
      ? Math.min(Math.floor(tool.defaultTopK), maxTopK)
      : undefined;
  return {
    enabled: tool.enabled !== false,
    ...(defaultTopK !== undefined ? { defaultTopK } : {}),
    maxTopK,
  };
}

function resolveControlPlane(
  raw: ControlPlanePluginConfig | undefined,
): ResolvedControlPlaneConfig {
  const cp = raw ?? {};
  return {
    sessionOverrides: cp.sessionOverrides !== false,
    oneShotTtlMs: positiveIntOr(cp.oneShotTtlMs, DEFAULT_ONE_SHOT_TTL_MS),
    command: cp.command !== false,
    gatewayMethods: cp.gatewayMethods !== false,
  };
}

interface SourceResolutionContext {
  geminiApiKey: string;
  lightragUrl: string;
  lightragApiKey: string;
  collections: string[];
  pgvectorEnabled: boolean;
  lightragEnabled: boolean;
  maxInjectChars: number;
  lightragMaxChars: number;
  testModeEnabled: boolean;
  warnings: string[];
}

/**
 * Build the named source registry. Without `sources`, the legacy flat keys
 * are synthesized into ids `pgvector` then `lightrag` (same order and the
 * same enablement rules as pre-4.0). With `sources`, each entry falls back
 * to the legacy keys for missing URL / key / collections.
 */
function resolveSources(
  cfg: KnowledgePluginConfig,
  ctx: SourceResolutionContext,
): ResolvedKnowledgeSource[] {
  const raw = cfg.sources;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    const out: ResolvedKnowledgeSource[] = [];
    // pgvector is listed only when it could be usable, so a LightRAG-only
    // deployment never advertises a phantom pgvector source to clients.
    if (cfg.pgvectorEnabled !== false && (ctx.geminiApiKey || ctx.testModeEnabled)) {
      out.push({
        id: LEGACY_PGVECTOR_SOURCE_ID,
        type: "pgvector",
        label: "Documents (pgvector)",
        description: "Semantic search over ingested document chunks.",
        enabled: ctx.pgvectorEnabled,
        url: "",
        apiKey: "",
        collections: ctx.collections,
        maxChars: ctx.maxInjectChars,
        legacy: true,
      });
    }
    if (cfg.lightragEnabled !== false && (ctx.lightragUrl || ctx.testModeEnabled)) {
      out.push({
        id: LEGACY_LIGHTRAG_SOURCE_ID,
        type: "lightrag",
        label: "Knowledge graph (LightRAG)",
        description: "Entity / relation knowledge graph built from ingested documents.",
        enabled: ctx.lightragEnabled,
        url: ctx.lightragUrl,
        apiKey: ctx.lightragApiKey,
        collections: [],
        maxChars: ctx.lightragMaxChars,
        legacy: true,
      });
    }
    return out;
  }

  const out: ResolvedKnowledgeSource[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const src = entry as KnowledgeSourcePluginConfig | undefined;
    if (!SOURCE_ID_PATTERN.test(id)) {
      ctx.warnings.push(`sources.${id}: invalid source id — ignored`);
      continue;
    }
    if (!src || (src.type !== "lightrag" && src.type !== "pgvector")) {
      ctx.warnings.push(`sources.${id}: type must be "lightrag" or "pgvector" — ignored`);
      continue;
    }
    const label = typeof src.label === "string" && src.label.trim() ? src.label.trim() : id;
    const description = typeof src.description === "string" ? src.description.trim() : "";
    const queryMode = isLightRAGMode(src.queryMode) ? src.queryMode : undefined;
    if (src.type === "lightrag") {
      const url = resolveEnv(src.url ?? "") || ctx.lightragUrl;
      const apiKey = resolveEnv(src.apiKey ?? "") || ctx.lightragApiKey;
      out.push({
        id,
        type: "lightrag",
        label,
        description,
        enabled: src.enabled !== false && (Boolean(url) || ctx.testModeEnabled),
        url,
        apiKey,
        collections: [],
        ...(queryMode ? { queryMode } : {}),
        maxChars: positiveIntOr(src.maxChars, ctx.lightragMaxChars),
        legacy: false,
      });
    } else {
      const collections = stringList(src.collections) ?? ctx.collections;
      out.push({
        id,
        type: "pgvector",
        label,
        description,
        enabled:
          src.enabled !== false &&
          collections.length > 0 &&
          (Boolean(ctx.geminiApiKey) || ctx.testModeEnabled),
        url: "",
        apiKey: "",
        collections,
        maxChars: positiveIntOr(src.maxChars, ctx.maxInjectChars),
        legacy: false,
      });
    }
  }
  return out;
}

/**
 * Resolve one policy level on top of `base`. Unknown ids are dropped with a
 * warning; ids of disabled sources are dropped silently (they may come back
 * once credentials are configured).
 *
 * Since 4.1.0 (control-plane contract 2) the two lists are independent:
 *   - `allowedSources` = this level's own list, else the PARENT's allowlist
 *     (`defaults.allowedSources`, else every enabled source). A level's
 *     `sources` never narrows what may be selected, so a client editing an
 *     agent's default selection does not change its entitlement, and a
 *     revocation at the parent level reaches every agent without its own list.
 *   - `sources` (the default selection) = this level's own list, else the
 *     parent's, always clamped to `allowedSources`. Own ids outside the
 *     allowlist are dropped with a warning.
 */
function resolvePolicy(
  raw: KnowledgeAgentPolicyPluginConfig | undefined,
  base: ResolvedAgentPolicy,
  knownIds: Set<string>,
  enabledIds: string[],
  path: string,
  warnings: string[],
): ResolvedAgentPolicy {
  const policy = raw ?? {};
  const filterIds = (ids: string[] | undefined, field: string): string[] | undefined => {
    if (ids === undefined) return undefined;
    const kept: string[] = [];
    for (const id of ids) {
      if (!knownIds.has(id)) {
        warnings.push(`${path}.${field}: unknown source id "${id}" — ignored`);
        continue;
      }
      if (enabledIds.includes(id) && !kept.includes(id)) kept.push(id);
    }
    return kept;
  };
  const sources = filterIds(stringList(policy.sources), "sources");
  const allowedExplicit = filterIds(stringList(policy.allowedSources), "allowedSources");
  const allowedSources = allowedExplicit ?? base.allowedSources;
  const outside = (sources ?? []).filter((id) => !allowedSources.includes(id));
  if (outside.length > 0) {
    warnings.push(
      `${path}.sources: source id(s) ${outside.map((id) => `"${id}"`).join(", ")} not in allowedSources — ignored`,
    );
  }
  const effectiveSources = (sources ?? base.sources).filter((id) => allowedSources.includes(id));
  return {
    injection: isInjectionPolicy(policy.injection) ? policy.injection : base.injection,
    sources: effectiveSources,
    allowedSources,
    allowedOrigin: allowedExplicit ? "own" : "inherited",
    ...(typeof policy.topK === "number" && policy.topK >= 1
      ? { topK: Math.floor(policy.topK) }
      : base.topK !== undefined
        ? { topK: base.topK }
        : {}),
    ...(isLightRAGMode(policy.lightragQueryMode)
      ? { lightragQueryMode: policy.lightragQueryMode }
      : base.lightragQueryMode
        ? { lightragQueryMode: base.lightragQueryMode }
        : {}),
    allowSessionOverrides:
      typeof policy.allowSessionOverrides === "boolean"
        ? policy.allowSessionOverrides
        : base.allowSessionOverrides,
  };
}

/**
 * Normalize mock source references into {@link LightRAGReference} objects. Accepts
 * either a bare path string (no content) or a rich `{ file_path, content[], reference_id }`
 * entry whose `content` (a string[] of chunks, like real LightRAG with
 * `include_chunk_content: true`) is joined through the SAME {@link normalizeReferenceContent}
 * the live parser uses — so TEST mode is a faithful proxy. Malformed / empty entries are
 * dropped (defense-in-depth against a config that slips past the JSON schema).
 */
function toLightRAGMockReferences(
  entries: Array<string | LightRAGMockReference>,
): LightRAGReference[] {
  if (!Array.isArray(entries)) return [];
  const out: LightRAGReference[] = [];
  for (const e of entries) {
    if (typeof e === "string") {
      if (e.length > 0) out.push({ file_path: e });
      continue;
    }
    if (!e || typeof e.file_path !== "string" || e.file_path.length === 0) continue;
    const ref: LightRAGReference = { file_path: e.file_path };
    if (typeof e.reference_id === "string" && e.reference_id.length > 0) {
      ref.reference_id = e.reference_id;
    }
    const content = normalizeReferenceContent(e.content);
    if (content) ref.content = content;
    out.push(ref);
  }
  return out;
}

/**
 * Normalize the operator's ergonomic mock shape into full
 * {@link PgvectorResult} rows: missing fields become `null`, a missing
 * collection falls back to `defaultCollection`, a missing/invalid score
 * clamps to `[0, 1]` (default `0.8`). The list is sorted by descending
 * score so it mirrors the cosine-ranked order the real pgvector path
 * produces in `runPgvectorSource`.
 */
function toPgvectorMockResults(
  mocks: PgvectorMockResult[],
  defaultCollection: string,
): PgvectorResult[] {
  if (!Array.isArray(mocks)) return [];
  return mocks
    .map((m): PgvectorResult => ({
      collection:
        typeof m.collection === "string" && m.collection.length > 0
          ? m.collection
          : defaultCollection,
      score: clamp01(typeof m.score === "number" ? m.score : DEFAULT_MOCK_SCORE),
      file_name: m.file_name ?? null,
      mime_type: null,
      text: m.text ?? null,
      file_id: null,
      source: null,
      owner: null,
      chunk_index: null,
      total_chunks: null,
      timestamp_start: null,
      timestamp_end: null,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Clamp a value to a non-negative integer. Bad input collapses to `0`. */
function clampNonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}
