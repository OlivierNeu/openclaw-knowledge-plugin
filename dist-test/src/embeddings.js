// Gemini embedding client for query vectors.
//
// We deliberately hit the *native* `embedContent` endpoint rather than the
// OpenAI-compatible one, because the OpenAI endpoint does not support
// multimodal inputs and we want to stay in the same embedding space as the
// n8n ingestion pipeline (which uses the native endpoint with images/audio).
const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/" +
    "models/gemini-embedding-2-preview:embedContent";
/**
 * Embed a text query via Gemini Embedding 2 Preview.
 * Uses the same model as n8n document ingestion so that query vectors and
 * stored chunks live in the same 3072-dimensional space.
 *
 * @throws Error on any non-OK HTTP response, with the first 200 chars of the
 *         error body for debugging.
 */
export async function embedQuery(text, geminiApiKey) {
    const url = `${GEMINI_EMBED_URL}?key=${geminiApiKey}`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: { parts: [{ text }] },
        }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Gemini embedding failed (${resp.status}): ${body.slice(0, 200)}`);
    }
    const data = (await resp.json());
    return data.embedding.values;
}
//# sourceMappingURL=embeddings.js.map