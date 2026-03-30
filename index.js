// openclaw-knowledge — Multi-collection Qdrant RAG plugin for OpenClaw
//
// Hooks into before_agent_start to search knowledge collections and inject
// relevant documents into the agent's context via prependContext.
// Results are wrapped in <relevant-memories> tags so mem0 autoCapture
// strips them before memorizing (avoids polluting conversational memory).
// Uses Gemini Embedding 2 Preview (native embedContent endpoint) for query
// embedding — same model/space as the multimodal document embeddings.
//
// Zero dependencies — uses Node.js native fetch.

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
 * Search a single Qdrant collection using a pre-computed vector.
 * Returns an array of results with score + payload fields.
 * Fails silently if the collection doesn't exist.
 */
async function searchCollection(
  collection,
  vector,
  topK,
  scoreThreshold,
  qdrantUrl,
  qdrantApiKey
) {
  const url = `${qdrantUrl}/collections/${collection}/points/query`;
  const headers = { "Content-Type": "application/json" };
  if (qdrantApiKey) headers["api-key"] = qdrantApiKey;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: vector,
        limit: topK,
        score_threshold: scoreThreshold,
        with_payload: true,
      }),
    });
  } catch {
    // Network error (Qdrant down, DNS failure, etc.)
    return [];
  }

  if (!resp.ok) return [];

  const data = await resp.json();
  const points = data.result?.points ?? [];

  return points.map((p) => ({
    collection,
    score: p.score,
    ...p.payload,
  }));
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
  name: "Qdrant Knowledge Base",
  description: "Multi-collection Qdrant RAG for OpenClaw",

  register(api) {
    const cfg = api.pluginConfig ?? {};

    // Resolve config with env var substitution
    const geminiApiKey = resolveEnv(cfg.geminiApiKey ?? "");
    const qdrantUrl = resolveEnv(cfg.qdrantUrl ?? "http://qdrant:6333");
    const qdrantApiKey = resolveEnv(cfg.qdrantApiKey ?? "");
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

    api.logger.info(
      `openclaw-knowledge: ready — searching ${collections.length} collection(s): ${collections.join(", ")}`
    );

    // Track consecutive errors for cooldown
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    let cooldownUntil = 0;

    // -----------------------------------------------------------------
    // Hook: before_agent_start
    // Injects knowledge results via prependContext wrapped in
    // <relevant-memories> tags. mem0 autoCapture strips these tags
    // before memorizing (PR #4065), preventing knowledge results
    // from being stored as conversational facts.
    // -----------------------------------------------------------------
    api.on("before_agent_start", async (event) => {
      if (!enabled) return;

      // Cooldown after repeated failures
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        if (Date.now() < cooldownUntil) return;
        consecutiveErrors = 0;
        api.logger.info("openclaw-knowledge: resuming after cooldown");
      }

      const query = event.prompt ?? "";
      if (!query || query.trim().length < 3) return;

      try {
        const vector = await embedQuery(query, geminiApiKey);

        const searches = collections.map((col) =>
          searchCollection(
            col,
            vector,
            topK,
            scoreThreshold,
            qdrantUrl,
            qdrantApiKey
          )
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
          prependContext: [
            "<relevant-memories>",
            "[Knowledge Base — personal documents]",
            "",
            formatted,
            "</relevant-memories>",
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
