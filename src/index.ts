// openclaw-knowledge — Multi-source knowledge plugin for OpenClaw
//
// Queries two knowledge sources in parallel and injects relevant context
// into the agent's system prompt via `appendSystemContext`:
//   1. PostgreSQL pgvector — semantic vector search on document embeddings
//   2. LightRAG — knowledge graph with entity/relation multi-hop search
//
// Hook: before_prompt_build (requires OpenClaw >= v2026.3.7)
// Depends on: pg (node-postgres)
//
// This is the canonical entry point for the plugin. Helpers live in sibling
// modules (`config.ts`, `embeddings.ts`, `pgvector.ts`, `lightrag.ts`) so the
// business logic can be unit-tested without instantiating the full SDK.

import pg from "pg";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";

import { resolveConfig } from "./config.js";
import { embedQuery } from "./embeddings.js";
import { searchCollection, formatPgvectorResults } from "./pgvector.js";
import { queryLightRAG, formatLightRAGResults } from "./lightrag.js";
import type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  KnowledgePluginConfig,
  PgPoolLike,
  PgvectorResult,
  PromptMessage,
  ResolvedKnowledgeConfig,
} from "./types.js";

// Re-export helpers so the test suite can import them directly without
// duplicating imports from every submodule.
export { resolveEnv, resolveConfig } from "./config.js";
export { embedQuery } from "./embeddings.js";
export { searchCollection, formatPgvectorResults } from "./pgvector.js";
export { queryLightRAG, truncateLightRAG, formatLightRAGResults } from "./lightrag.js";
export type {
  BeforePromptBuildEvent,
  BeforePromptBuildResult,
  KnowledgePluginConfig,
  LightRAGQueryMode,
  PgPoolLike,
  PgvectorResult,
  PgvectorRow,
  PromptContentPart,
  PromptMessage,
  ResolvedKnowledgeConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Hook handler factory
//
// Extracted from `register` so tests can exercise the handler directly
// without mocking the full plugin API surface.
// ---------------------------------------------------------------------------

const MAX_CONSECUTIVE_ERRORS = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_QUERY_LENGTH = 3;

interface HookHandlerDeps {
  config: ResolvedKnowledgeConfig;
  pool: PgPoolLike | null;
  logger: PluginLogger;
}

/**
 * Build the `before_prompt_build` handler bound to a specific plugin state.
 * Kept as a pure factory so the handler can be unit-tested with fake deps.
 */
export function createBeforePromptBuildHandler(
  deps: HookHandlerDeps,
): (event: BeforePromptBuildEvent) => Promise<BeforePromptBuildResult | undefined> {
  const { config, pool, logger } = deps;

  // Per-instance state: consecutive failure counter and cooldown deadline.
  // Closed-over so two registrations of the hook never share state.
  let consecutiveErrors = 0;
  let cooldownUntil = 0;

  return async function beforePromptBuild(
    event: BeforePromptBuildEvent,
  ): Promise<BeforePromptBuildResult | undefined> {
    if (!config.enabled) return undefined;

    // Cooldown after repeated failures: skip silently until the deadline
    // passes, then reset the counter and resume normal operation.
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      if (Date.now() < cooldownUntil) return undefined;
      consecutiveErrors = 0;
      logger.info("openclaw-knowledge: resuming after cooldown");
    }

    const query = extractQueryFromMessages(event.messages);
    if (!query || query.trim().length < MIN_QUERY_LENGTH) return undefined;

    try {
      const tasks: Promise<SourceResult>[] = [];

      if (config.pgvectorEnabled && pool) {
        tasks.push(runPgvectorSource(pool, query, config));
      }

      if (config.lightragEnabled) {
        tasks.push(runLightRAGSource(query, config));
      }

      const settled = await Promise.allSettled(tasks);

      const sections: string[] = [];
      let failedSources = 0;

      for (const result of settled) {
        if (result.status === "rejected") {
          failedSources++;
          const reason = result.reason as { message?: string } | undefined;
          logger.error(
            `openclaw-knowledge: source failed — ${reason?.message ?? String(result.reason)}`,
          );
          continue;
        }

        const section = renderSection(result.value, config, logger);
        if (section) sections.push(section);
      }

      // If every source we launched failed, treat the turn as a failure for
      // cooldown tracking. A partial failure is fine — the other source's
      // context is better than nothing.
      if (failedSources > 0 && failedSources === tasks.length) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          cooldownUntil = Date.now() + COOLDOWN_MS;
          logger.error(
            `openclaw-knowledge: ${consecutiveErrors} consecutive errors — cooling down 5 min`,
          );
        }
        return undefined;
      }

      consecutiveErrors = 0;

      if (sections.length === 0) return undefined;

      return {
        appendSystemContext: [
          "",
          "## Relevant Knowledge Base",
          "Use this information to answer the user's question accurately.",
          "Always cite the source document name when using this information.",
          "",
          ...sections,
        ].join("\n"),
      };
    } catch (err) {
      // Catch-all: an unexpected crash must never propagate to the agent.
      consecutiveErrors++;
      const message = err instanceof Error ? err.message : String(err);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        logger.error(
          `openclaw-knowledge: ${consecutiveErrors} consecutive errors — cooling down 5 min: ${message}`,
        );
      } else {
        logger.error(`openclaw-knowledge: ${message}`);
      }
      return undefined;
    }
  };
}

type SourceResult =
  | { source: "pgvector"; data: PgvectorResult[] }
  | { source: "lightrag"; data: string };

/**
 * Extract the most recent user message text from an array of prompt messages.
 * Supports three content shapes OpenClaw may surface:
 *   - plain string
 *   - array of content parts (multi-modal, text-only parts kept)
 *   - legacy `{text: "..."}` form
 */
function extractQueryFromMessages(
  messages: PromptMessage[] | undefined,
): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    const role = msg.role ?? msg.sender ?? "";
    if (role !== "user" && role !== "human") continue;

    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join(" ");
    }
    return msg.text ?? "";
  }

  return "";
}

async function runPgvectorSource(
  pool: PgPoolLike,
  query: string,
  config: ResolvedKnowledgeConfig,
): Promise<SourceResult> {
  const vector = await embedQuery(query, config.geminiApiKey);
  const searches = config.collections.map((col) =>
    searchCollection(pool, col, vector, config.topK, config.scoreThreshold),
  );
  const allResults = (await Promise.all(searches)).flat();
  allResults.sort((a, b) => b.score - a.score);
  return { source: "pgvector", data: allResults };
}

async function runLightRAGSource(
  query: string,
  config: ResolvedKnowledgeConfig,
): Promise<SourceResult> {
  const context = await queryLightRAG(
    config.lightragUrl,
    config.lightragApiKey,
    query,
    config.lightragQueryMode,
  );
  return { source: "lightrag", data: context };
}

function renderSection(
  result: SourceResult,
  config: ResolvedKnowledgeConfig,
  logger: PluginLogger,
): string | null {
  if (result.source === "pgvector") {
    const formatted = formatPgvectorResults(result.data, config.maxInjectChars);
    if (!formatted) return null;
    const topScore = result.data[0]?.score?.toFixed(2) ?? "n/a";
    logger.info(
      `openclaw-knowledge: pgvector — ${result.data.length} result(s) (top: ${topScore})`,
    );
    return "### Document Search Results (pgvector)\n" + formatted;
  }

  if (result.source === "lightrag") {
    const formatted = formatLightRAGResults(result.data, config.lightragMaxChars);
    if (!formatted) return null;
    logger.info(
      `openclaw-knowledge: LightRAG — ${formatted.truncated.length}/${formatted.originalLength} chars (truncated from ${formatted.originalLength})`,
    );
    return "### Knowledge Graph Context (LightRAG)\n" + formatted.truncated;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Plugin registration helper
//
// Exposed so tests can exercise the full wiring (including api.on) without
// going through `definePluginEntry`, which is tied to the SDK runtime.
// ---------------------------------------------------------------------------

/**
 * Register the plugin against a minimal shape-compatible subset of the
 * OpenClaw plugin API. Returns nothing; side effects are setting a hook and
 * logging the initial status.
 */
export function registerKnowledgePlugin(api: OpenClawPluginApi): void {
  const rawConfig = (api.pluginConfig ?? {}) as KnowledgePluginConfig;
  const config = resolveConfig(rawConfig);

  if (!config.pgvectorEnabled && !config.lightragEnabled) {
    api.logger.warn(
      "openclaw-knowledge: neither pgvector nor LightRAG configured — plugin disabled",
    );
    return;
  }

  // Only instantiate the pg pool when pgvector is actually in play. Booting
  // a pool with no valid connection string would keep the plugin disabled
  // anyway and leak sockets on hot-reload.
  let pool: PgPoolLike | null = null;
  if (config.pgvectorEnabled) {
    const realPool = new pg.Pool({
      connectionString: config.postgresUrl,
      max: 3,
      idleTimeoutMillis: 30000,
    });
    realPool.on("error", (err: Error) => {
      api.logger.error(`openclaw-knowledge: pool error — ${err.message}`);
    });
    pool = realPool;
  }

  const sources: string[] = [];
  if (config.pgvectorEnabled) {
    sources.push(`pgvector (${config.collections.join(", ")})`);
  }
  if (config.lightragEnabled) {
    sources.push(`LightRAG (${config.lightragQueryMode})`);
  }
  api.logger.info(
    `openclaw-knowledge: ready — sources: ${sources.join(" + ")}`,
  );

  const handler = createBeforePromptBuildHandler({
    config,
    pool,
    logger: api.logger,
  });

  // The SDK's `api.on<K>` signature is strongly typed per hook name, so we
  // use a cast here to bridge our structural handler type with the precise
  // `PluginHookHandlerMap["before_prompt_build"]` expected signature.
  // The handler itself is fully type-safe on its own contract (see
  // {@link createBeforePromptBuildHandler}).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api.on as (event: string, handler: any) => void)(
    "before_prompt_build",
    handler,
  );
}

// ---------------------------------------------------------------------------
// Canonical plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "openclaw-knowledge",
  name: "Knowledge Base",
  description:
    "Multi-source knowledge search for OpenClaw (pgvector + LightRAG)",
  register(api) {
    registerKnowledgePlugin(api);
  },
});
