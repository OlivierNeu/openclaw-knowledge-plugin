// Plugin configuration helpers.
//
// These helpers are the only place that touches `process.env`, keeping the
// rest of the plugin easy to test with deterministic values.
/**
 * Expand `${VAR_NAME}` patterns in a config string against `process.env`.
 * Non-string values are returned untouched so the helper can be used on any
 * raw config field without type narrowing at the call site. Missing env vars
 * become empty strings to avoid leaking `undefined` into downstream code.
 */
export function resolveEnv(value) {
    if (typeof value !== "string")
        return value;
    return value.replace(/\$\{(\w+)\}/g, (_, name) => {
        return process.env[name] ?? "";
    });
}
const DEFAULT_POSTGRES_URL = "postgresql://openclaw:@postgresql:5432/knowledge";
const DEFAULT_COLLECTIONS = ["knowledge_default"];
const DEFAULT_TOP_K = 5;
const DEFAULT_SCORE_THRESHOLD = 0.3;
const DEFAULT_MAX_INJECT_CHARS = 4000;
const DEFAULT_LIGHTRAG_MODE = "hybrid";
const DEFAULT_LIGHTRAG_MAX_CHARS = 4000;
/**
 * Apply defaults and env substitution to the raw config coming from
 * `api.pluginConfig`. Mirrors the original JS implementation exactly so
 * existing user configs keep behaving the same after the TS migration.
 */
export function resolveConfig(raw) {
    const cfg = raw ?? {};
    const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
    const postgresUrl = resolveEnv(cfg.postgresUrl ?? DEFAULT_POSTGRES_URL);
    const collections = cfg.collections ?? DEFAULT_COLLECTIONS;
    const topK = cfg.topK ?? DEFAULT_TOP_K;
    const scoreThreshold = cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
    const maxInjectChars = cfg.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS;
    // pgvector is active only when a Gemini key is configured, unless the user
    // explicitly toggles it off.
    const pgvectorEnabled = cfg.pgvectorEnabled !== false && Boolean(geminiApiKey);
    const lightragUrl = resolveEnv(cfg.lightragUrl ?? "");
    const lightragApiKey = resolveEnv(cfg.lightragApiKey ?? "");
    const lightragQueryMode = cfg.lightragQueryMode ?? DEFAULT_LIGHTRAG_MODE;
    const lightragMaxChars = cfg.lightragMaxChars ?? DEFAULT_LIGHTRAG_MAX_CHARS;
    // Same mirrored derivation: LightRAG active when a URL is set unless the
    // user toggled it off explicitly.
    const lightragEnabled = cfg.lightragEnabled !== false && Boolean(lightragUrl);
    const enabled = cfg.enabled !== false;
    return {
        enabled,
        geminiApiKey,
        postgresUrl,
        collections,
        topK,
        scoreThreshold,
        maxInjectChars,
        pgvectorEnabled,
        lightragUrl,
        lightragApiKey,
        lightragQueryMode,
        lightragMaxChars,
        lightragEnabled,
    };
}
//# sourceMappingURL=config.js.map