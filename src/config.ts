// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.

import { DEFAULT_RPM_BUDGET } from "./jina/rate-limit.js";
import type { RerankerModel } from "./jina/types.js";
import { resolveProvenanceLevel } from "./provenance.js";
import { DEFAULT_MIN_CONFIDENCE } from "./router/index.js";
import type {
  JinaPluginConfig,
  KnowledgePluginConfig,
  LightRAGQueryMode,
  PgvectorRerankerPluginConfig,
  ResolvedKnowledgeConfig,
  RouterPluginConfig,
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

const DEFAULT_ROUTER_MODE: "heuristic" | "jina-classifier" = "heuristic";
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

  return {
    enabled: cfg.enabled !== false,
    geminiApiKey,
    postgresUrl,
    collections: cfg.collections ?? DEFAULT_COLLECTIONS,
    topK: cfg.topK ?? DEFAULT_TOP_K,
    scoreThreshold: cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    maxInjectChars: cfg.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS,
    pgvectorEnabled: cfg.pgvectorEnabled !== false && Boolean(geminiApiKey),
    lightragUrl,
    lightragApiKey,
    lightragQueryMode: cfg.lightragQueryMode ?? DEFAULT_LIGHTRAG_MODE,
    lightragMaxChars: cfg.lightragMaxChars ?? DEFAULT_LIGHTRAG_MAX_CHARS,
    lightragEnabled: cfg.lightragEnabled !== false && Boolean(lightragUrl),

    // Jina shared key (used by router and/or reranker)
    jinaApiKey,
    // 3.2.4 — soft RPM budget. 0 disables the monitor entirely.
    jinaRpmBudget: clampNonNegInt(jina.rpmBudget ?? DEFAULT_RPM_BUDGET),

    // Router — disabled by default, even with a Jina key present, so
    // operators must opt in explicitly. "heuristic" mode is the safest
    // entry point: zero cost, deterministic.
    routerEnabled: router.enabled === true,
    routerMode: router.mode ?? DEFAULT_ROUTER_MODE,
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

    // 3.3.0 — provenance reporting toward chat frontends. Off-list values
    // (typos, future levels) normalize to "off": a misconfiguration must
    // never silently leak content.
    provenanceReport: resolveProvenanceLevel(cfg.provenanceReport),
  };
}

/** Clamp a value to a non-negative integer. Bad input collapses to `0`. */
function clampNonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}
