// openclaw-knowledge — Multi-collection pgvector RAG plugin for OpenClaw
//
// Hooks into before_prompt_build to search knowledge collections stored in
// PostgreSQL (pgvector) and inject relevant documents into the agent's
// system prompt via appendSystemContext.
// Uses Gemini Embedding 2 Preview (native embedContent endpoint) for query
// embedding — same model/space as the multimodal document embeddings.
//
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
 * Format search results for injection into the agent's prompt.
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

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

export { resolveEnv, embedQuery, searchCollection, formatResults };

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  id: "openclaw-knowledge",
  name: "pgvector Knowledge Base",
  description: "Multi-collection pgvector RAG for OpenClaw",

  register(api) {
    const cfg = api.pluginConfig ?? {};

    // Resolve config with env var substitution
    const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
    const postgresUrl = resolveEnv(
      cfg.postgresUrl ?? "postgresql://openclaw:@postgresql:5432/knowledge"
    );
    const collections = cfg.collections ?? ["knowledge_default"];
    const topK = cfg.topK ?? 5;
    const scoreThreshold = cfg.scoreThreshold ?? 0.3;
    const maxInjectChars = cfg.maxInjectChars ?? 4000;
    const enabled = cfg.enabled !== false;

    // Validate required config
    if (!geminiApiKey) {
      api.logger.warn(
        "openclaw-knowledge: GEMINI_API_KEY not configured — plugin disabled"
      );
      return;
    }

    // Initialize PostgreSQL connection pool
    const pool = new pg.Pool({
      connectionString: postgresUrl,
      max: 3,
      idleTimeoutMillis: 30000,
    });

    pool.on("error", (err) => {
      api.logger.error(`openclaw-knowledge: pool error — ${err.message}`);
    });

    api.logger.info(
      `openclaw-knowledge: ready — searching ${collections.length} collection(s): ${collections.join(", ")}`
    );

    // Track consecutive errors for cooldown
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let cooldownUntil = 0;

    // -----------------------------------------------------------------
    // Hook: before_prompt_build (requires OpenClaw >= v2026.3.7)
    // Injects knowledge into the SYSTEM PROMPT via appendSystemContext.
    // Invisible in PinchChat/Control UI — only the LLM sees it.
    // Same pattern as LangChain/LlamaIndex RAG: context in system msg.
    //
    // Note: event.prompt is the system prompt being built, NOT the user
    // message. The user message is extracted from event.messages.
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
      // event.prompt = system prompt being built, NOT the user question
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
        const vector = await embedQuery(query, geminiApiKey);

        const searches = collections.map((col) =>
          searchCollection(pool, col, vector, topK, scoreThreshold)
        );
        const allResults = (await Promise.all(searches)).flat();
        allResults.sort((a, b) => b.score - a.score);

        const formatted = formatResults(allResults, maxInjectChars);
        if (!formatted) {
          consecutiveErrors = 0;
          return;
        }

        api.logger.info(
          `openclaw-knowledge: injecting ${allResults.length} result(s) (top score: ${allResults[0]?.score?.toFixed(2) ?? "n/a"})`
        );

        consecutiveErrors = 0;

        return {
          appendSystemContext: [
            "",
            "## Relevant Knowledge Base Documents",
            "Use this information to answer the user's question accurately.",
            "Always cite the source document name when using this information.",
            "",
            formatted,
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
