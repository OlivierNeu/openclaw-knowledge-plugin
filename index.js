// openclaw-knowledge — Multi-source knowledge plugin for OpenClaw
//
// Queries two knowledge sources in parallel and injects relevant context
// into the agent's system prompt via appendSystemContext:
//   1. PostgreSQL pgvector — semantic vector search on document embeddings
//   2. LightRAG — knowledge graph with entity/relation multi-hop search
//
// Hook: before_prompt_build (requires OpenClaw >= v2026.3.7)
// Depends on: pg (node-postgres)

import pg from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve ${VAR_NAME} patterns in config string values.
 * Allows using environment variable references in openclaw.json config.
 */
function resolveEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

/**
 * Embed a text query via Gemini Embedding 2 Preview (native endpoint).
 * Uses the same model as n8n document ingestion so vectors are in the same space.
 * Note: uses the native embedContent endpoint, NOT the OpenAI-compatible one,
 * because the OpenAI endpoint doesn't support multimodal (text only).
 */
async function embedQuery(text, geminiApiKey) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/" +
    "models/gemini-embedding-2-preview:embedContent" +
    `?key=${geminiApiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Gemini embedding failed (${resp.status}): ${body.slice(0, 200)}`
    );
  }

  const data = await resp.json();
  return data.embedding.values;
}

/**
 * Search a collection in PostgreSQL pgvector using cosine similarity.
 * Uses halfvec(3072) cast for HNSW index compatibility (pgvector HNSW
 * limit is 2000 dims for vector type, halfvec supports up to 4000).
 * Score filtering is done in JS after the query to allow the HNSW
 * index to handle the ORDER BY + LIMIT efficiently.
 */
async function searchCollection(
  pool,
  collection,
  vector,
  topK,
  scoreThreshold
) {
  const vectorStr = `[${vector.join(",")}]`;

  try {
    const result = await pool.query(
      `SELECT file_name, mime_type, text, file_id, source, owner,
              chunk_index, total_chunks, timestamp_start, timestamp_end,
              embedded_at,
              1 - (embedding::halfvec(3072) <=> $1::halfvec(3072)) AS score
       FROM knowledge_vectors
       WHERE collection = $2
       ORDER BY embedding::halfvec(3072) <=> $1::halfvec(3072)
       LIMIT $3`,
      [vectorStr, collection, topK]
    );

    return result.rows
      .filter((row) => parseFloat(row.score) >= scoreThreshold)
      .map((row) => ({
        collection,
        score: parseFloat(row.score),
        file_name: row.file_name,
        mime_type: row.mime_type,
        text: row.text,
        file_id: row.file_id,
        source: row.source,
        owner: row.owner,
        chunk_index: row.chunk_index,
        total_chunks: row.total_chunks,
        timestamp_start: row.timestamp_start,
        timestamp_end: row.timestamp_end,
      }));
  } catch {
    return [];
  }
}

/**
 * Format pgvector search results for injection into the agent's prompt.
 * Respects maxChars limit to avoid bloating the context window.
 * Includes: file name, score, timestamps (for video/audio), and text content.
 */
function formatResults(results, maxChars) {
  if (results.length === 0) return null;

  let output = "";
  for (const r of results) {
    const lines = [
      `[${r.collection}] ${r.file_name || "unknown"} (score: ${r.score.toFixed(2)})`,
    ];

    if (r.timestamp_start) {
      lines.push(`Segment: ${r.timestamp_start} - ${r.timestamp_end}`);
    }

    if (r.text) {
      lines.push(`Content: ${r.text}`);
    }

    lines.push(""); // blank line separator
    const entry = lines.join("\n");

    if (output.length + entry.length > maxChars) break;
    output += entry;
  }

  return output;
}

/**
 * Query LightRAG knowledge graph for relevant context.
 * Uses only_need_context=true to retrieve raw context without LLM processing.
 * LightRAG returns entities, relationships, and source chunks assembled as text.
 *
 * Modes: naive (simple vector), local (entity neighborhood), global (community
 * summaries), hybrid (local + global — best for most queries).
 */
async function queryLightRAG(url, apiKey, query, mode) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const resp = await fetch(`${url}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      mode: mode || "hybrid",
      only_need_context: true,
      stream: false,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `LightRAG query failed (${resp.status}): ${body.slice(0, 200)}`
    );
  }

  const data = await resp.json();

  // LightRAG with only_need_context returns the assembled context
  if (typeof data === "string") return data;
  return data.response ?? data.context ?? "";
}

/**
 * Truncate LightRAG context to maxChars without cutting mid-sentence.
 */
function truncateLightRAG(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf(".");
  return lastPeriod > maxChars * 0.5
    ? truncated.slice(0, lastPeriod + 1)
    : truncated;
}

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

export {
  resolveEnv,
  embedQuery,
  searchCollection,
  formatResults,
  queryLightRAG,
  truncateLightRAG,
};

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  id: "openclaw-knowledge",
  name: "Knowledge Base",
  description:
    "Multi-source knowledge search for OpenClaw (pgvector + LightRAG)",

  register(api) {
    const cfg = api.pluginConfig ?? {};

    // --- pgvector config ---
    const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
    const postgresUrl = resolveEnv(
      cfg.postgresUrl ?? "postgresql://openclaw:@postgresql:5432/knowledge"
    );
    const collections = cfg.collections ?? ["knowledge_default"];
    const topK = cfg.topK ?? 5;
    const scoreThreshold = cfg.scoreThreshold ?? 0.3;
    const maxInjectChars = cfg.maxInjectChars ?? 4000;
    const pgvectorEnabled = cfg.pgvectorEnabled !== false && !!geminiApiKey;

    // --- LightRAG config ---
    const lightragUrl = resolveEnv(cfg.lightragUrl ?? "");
    const lightragApiKey = resolveEnv(cfg.lightragApiKey ?? "");
    const lightragQueryMode = cfg.lightragQueryMode ?? "hybrid";
    const lightragMaxChars = cfg.lightragMaxChars ?? 4000;
    const lightragEnabled = cfg.lightragEnabled !== false && !!lightragUrl;

    // Global enabled flag
    const enabled = cfg.enabled !== false;

    if (!pgvectorEnabled && !lightragEnabled) {
      api.logger.warn(
        "openclaw-knowledge: neither pgvector nor LightRAG configured — plugin disabled"
      );
      return;
    }

    // Initialize PostgreSQL connection pool (only if pgvector enabled)
    let pool = null;
    if (pgvectorEnabled) {
      pool = new pg.Pool({
        connectionString: postgresUrl,
        max: 3,
        idleTimeoutMillis: 30000,
      });
      pool.on("error", (err) => {
        api.logger.error(`openclaw-knowledge: pool error — ${err.message}`);
      });
    }

    const sources = [];
    if (pgvectorEnabled) sources.push(`pgvector (${collections.join(", ")})`);
    if (lightragEnabled) sources.push(`LightRAG (${lightragQueryMode})`);
    api.logger.info(
      `openclaw-knowledge: ready — sources: ${sources.join(" + ")}`
    );

    // Track consecutive errors for cooldown
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let cooldownUntil = 0;

    // -----------------------------------------------------------------
    // Hook: before_prompt_build
    // Queries both sources in parallel and injects combined context.
    // -----------------------------------------------------------------
    api.on("before_prompt_build", async (event) => {
      if (!enabled) return;

      // Cooldown after repeated failures
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        if (Date.now() < cooldownUntil) return;
        consecutiveErrors = 0;
        api.logger.info("openclaw-knowledge: resuming after cooldown");
      }

      // Extract user message from event.messages (last user message)
      let query = "";
      if (Array.isArray(event.messages) && event.messages.length > 0) {
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const msg = event.messages[i];
          const role = msg.role ?? msg.sender ?? "";
          if (role === "user" || role === "human") {
            if (typeof msg.content === "string") {
              query = msg.content;
            } else if (Array.isArray(msg.content)) {
              query = msg.content
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text)
                .join(" ");
            } else {
              query = msg.text ?? "";
            }
            break;
          }
        }
      }

      if (!query || query.trim().length < 3) return;

      try {
        // Run both sources in parallel
        const tasks = [];

        // pgvector search
        if (pgvectorEnabled && pool) {
          tasks.push(
            (async () => {
              const vector = await embedQuery(query, geminiApiKey);
              const searches = collections.map((col) =>
                searchCollection(pool, col, vector, topK, scoreThreshold)
              );
              const allResults = (await Promise.all(searches)).flat();
              allResults.sort((a, b) => b.score - a.score);
              return { source: "pgvector", data: allResults };
            })()
          );
        }

        // LightRAG search
        if (lightragEnabled) {
          tasks.push(
            (async () => {
              const context = await queryLightRAG(
                lightragUrl,
                lightragApiKey,
                query,
                lightragQueryMode
              );
              return { source: "lightrag", data: context };
            })()
          );
        }

        const results = await Promise.allSettled(tasks);

        // Assemble context from both sources
        const sections = [];
        let failedSources = 0;

        for (const result of results) {
          if (result.status === "rejected") {
            failedSources++;
            api.logger.error(
              `openclaw-knowledge: source failed — ${result.reason?.message ?? result.reason}`
            );
            continue;
          }

          const { source, data } = result.value;

          if (source === "pgvector") {
            const formatted = formatResults(data, maxInjectChars);
            if (formatted) {
              sections.push(
                "### Document Search Results (pgvector)\n" + formatted
              );
              api.logger.info(
                `openclaw-knowledge: pgvector — ${data.length} result(s) (top: ${data[0]?.score?.toFixed(2) ?? "n/a"})`
              );
            }
          }

          if (source === "lightrag") {
            const context =
              typeof data === "string" ? data.trim() : "";
            if (context.length > 0) {
              sections.push(
                "### Knowledge Graph Context (LightRAG)\n" +
                  truncateLightRAG(context, lightragMaxChars)
              );
              api.logger.info(
                `openclaw-knowledge: LightRAG — ${context.length} chars`
              );
            }
          }
        }

        // Track consecutive failures (all sources failed)
        if (failedSources > 0 && failedSources === tasks.length) {
          consecutiveErrors++;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            cooldownUntil = Date.now() + 5 * 60 * 1000;
            api.logger.error(
              `openclaw-knowledge: ${consecutiveErrors} consecutive errors — cooling down 5 min`
            );
          }
          return;
        }

        consecutiveErrors = 0;

        if (sections.length === 0) return;

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
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          cooldownUntil = Date.now() + 5 * 60 * 1000;
          api.logger.error(
            `openclaw-knowledge: ${consecutiveErrors} consecutive errors — cooling down 5 min: ${err.message}`
          );
        } else {
          api.logger.error(`openclaw-knowledge: ${err.message}`);
        }
      }
    });
  },
};
