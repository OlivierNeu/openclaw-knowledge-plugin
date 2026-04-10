// Type definitions for the openclaw-knowledge plugin.
//
// Kept separate from the entry point so that tests and helper modules can
// import them without pulling in the full plugin registration code.

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
}

export type LightRAGQueryMode = "naive" | "local" | "global" | "hybrid";

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
}

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

/**
 * Shape of the `before_prompt_build` event payload as consumed by this plugin.
 * We only rely on `messages`; the SDK may add other fields that we ignore.
 */
export interface BeforePromptBuildEvent {
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
