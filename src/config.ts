// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.

import type {
  KnowledgePluginConfig,
  LightRAGQueryMode,
  ResolvedKnowledgeConfig,
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

/**
 * Apply defaults and env substitution to the raw plugin config. A source is
 * enabled when its credentials are present, unless the user explicitly toggles
 * `pgvectorEnabled`/`lightragEnabled` off.
 */
export function resolveConfig(
  cfg: KnowledgePluginConfig = {},
): ResolvedKnowledgeConfig {
  const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
  const postgresUrl = resolveEnv(cfg.postgresUrl ?? DEFAULT_POSTGRES_URL);
  const lightragUrl = resolveEnv(cfg.lightragUrl ?? "");
  const lightragApiKey = resolveEnv(cfg.lightragApiKey ?? "");

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
  };
}
