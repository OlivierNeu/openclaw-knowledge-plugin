// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.

import type { RerankerModel } from "./jina/types.js";
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

const DEFAULT_POSTGRES_URL = "postgresql://openclaw:@postgresql:5432/knowledge";
const DEFAULT_COLLECTIONS = ["knowledge_default"];
const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_THRESHOLD = 0.3;
const DEFAULT_MAX_INJECT_CHARS = 4000;
const DEFAULT_LIGHTRAG_MODE: LightRAGQueryMode = "hybrid";
const DEFAULT_LIGHTRAG_MAX_CHARS = 4000;

const DEFAULT_ROUTER_MODE: "heuristic" | "jina-classifier" = "heuristic";
const DEFAULT_RERANKER_MODEL: RerankerModel = "jina-reranker-v2-base-multilingual";
const DEFAULT_RERANKER_TOP_N = 5;

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

    // Router — disabled by default, even with a Jina key present, so
    // operators must opt in explicitly. "heuristic" mode is the safest
    // entry point: zero cost, deterministic.
    routerEnabled: router.enabled === true,
    routerMode: router.mode ?? DEFAULT_ROUTER_MODE,
    routerClassifierId,

    // Pgvector reranker — disabled by default. Requires both the toggle
    // and a Jina key to actually activate at runtime (the handler checks
    // this combination before calling).
    pgvectorRerankerEnabled: reranker.enabled === true && Boolean(jinaApiKey),
    pgvectorRerankerModel: reranker.model ?? DEFAULT_RERANKER_MODEL,
    pgvectorRerankerTopN: reranker.topN ?? DEFAULT_RERANKER_TOP_N,
  };
}
