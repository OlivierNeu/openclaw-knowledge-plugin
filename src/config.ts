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
  JinaPluginConfig,
  KnowledgePluginConfig,
  LightRAGMockReference,
  LightRAGQueryMode,
  LightRAGReference,
  PgvectorMockResult,
  PgvectorRerankerPluginConfig,
  PgvectorResult,
  ResolvedKnowledgeConfig,
  RouterPluginConfig,
  TestModePluginConfig,
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

// 3.2.9 — default LightRAG mock source references. Aligned with the default mock
// context (which names guide-deploiement-helios.md) so a TEST deployment surfaces a
// realistic "Sources" panel for the graph path. Since 3.2.12 each carries `content`
// as a string[] of retrieved chunks — EXACTLY the shape real LightRAG returns with
// `include_chunk_content: true` — so a TEST deployment exercises the per-document
// excerpt path end-to-end (documents show their retrieved text, not just an id).
const DEFAULT_LIGHTRAG_MOCK_REFERENCES: LightRAGMockReference[] = [
  {
    file_path: "guide-deploiement-helios.md",
    reference_id: "1",
    content: [
      "Le deploiement d'Helios se fait en trois etapes : preparation de l'environnement, application des migrations, puis bascule du trafic.",
      "Chaque etape est reversible ; un rollback restaure l'etat precedent sans perte de donnees.",
    ],
  },
  {
    file_path: "faq-helios.md",
    reference_id: "2",
    content: [
      "Q : Helios supporte-t-il le multi-tenant ? R : Oui, chaque tenant est isole par schema, sans partage de donnees.",
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

  return {
    enabled: cfg.enabled !== false,
    geminiApiKey,
    postgresUrl,
    collections,
    topK: cfg.topK ?? DEFAULT_TOP_K,
    scoreThreshold: cfg.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
    maxInjectChars: cfg.maxInjectChars ?? DEFAULT_MAX_INJECT_CHARS,
    pgvectorEnabled:
      cfg.pgvectorEnabled !== false && (Boolean(geminiApiKey) || testModeEnabled),
    lightragUrl,
    lightragApiKey,
    lightragQueryMode: cfg.lightragQueryMode ?? DEFAULT_LIGHTRAG_MODE,
    lightragMaxChars: cfg.lightragMaxChars ?? DEFAULT_LIGHTRAG_MAX_CHARS,
    lightragEnabled:
      cfg.lightragEnabled !== false && (Boolean(lightragUrl) || testModeEnabled),

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
