# openclaw-knowledge-plugin

Multi-collection Qdrant knowledge search plugin for OpenClaw — automatic RAG injection with Gemini Embedding 2.

## What it does

This plugin hooks into OpenClaw's `before_agent_start` lifecycle event to **automatically** search your Qdrant knowledge collections before every agent turn. Results are injected into the agent's context via `prependContext`, so the agent always has access to relevant documents without the user needing to ask for it.

This is **deterministic** — unlike skills, the search runs on every message, not when the LLM decides to use it.

## How it works

```
User sends message
    |
    v
[before_agent_start hook]
    |
    +--> Embed query via Gemini Embedding 2 Preview (text mode)
    |
    +--> Search N Qdrant collections in parallel
    |
    +--> Sort results by similarity score
    |
    +--> Inject <relevant-documents> block into prompt
    |
    v
Agent responds with document context
```

The query embedding uses the same model (`gemini-embedding-2-preview`, 3072 dimensions) as the document ingestion pipeline, ensuring cross-modal compatibility: a text query finds documents embedded as multimodal content (PDFs, images, audio, video).

## Features

- **Multi-collection search** — query multiple Qdrant collections in parallel
- **Deterministic** — runs on every message via `before_agent_start` hook
- **Cross-modal compatible** — text queries find multimodal documents (same embedding space)
- **Coexists with mem0** — no slot conflict, complements conversational memory
- **Zero dependencies** — uses Node.js native `fetch`
- **Fail-safe** — errors are silently caught, never blocks the agent
- **Cooldown** — pauses 5 min after 3 consecutive errors to avoid log spam
- **Configurable** — score threshold, top-K, max injection size, per-instance collections

## Installation

### Copy to OpenClaw extensions

```bash
sudo cp -r openclaw-knowledge-plugin \
  /path/to/.openclaw/extensions/openclaw-knowledge
```

### Configure via CLI

```bash
# Add to plugin allowlist
openclaw config set plugins.allow '["openclaw-mem0", "openclaw-knowledge", "telegram", "whatsapp"]'

# Enable and configure
openclaw config set plugins.entries.openclaw-knowledge.enabled true
openclaw config set plugins.entries.openclaw-knowledge.config.geminiApiKey '${GEMINI_API_KEY}'
openclaw config set plugins.entries.openclaw-knowledge.config.qdrantUrl "http://qdrant:6333"
openclaw config set plugins.entries.openclaw-knowledge.config.qdrantApiKey '${QDRANT_API_KEY}'
openclaw config set plugins.entries.openclaw-knowledge.config.collections '["knowledge_olivier"]'
```

### Restart

```bash
openclaw gateway restart
```

## Configuration

Add to `openclaw.json` under `plugins.entries`:

```json
{
  "openclaw-knowledge": {
    "enabled": true,
    "config": {
      "geminiApiKey": "${GEMINI_API_KEY}",
      "qdrantUrl": "http://qdrant:6333",
      "qdrantApiKey": "${QDRANT_API_KEY}",
      "collections": ["knowledge_olivier", "knowledge_business"],
      "topK": 5,
      "scoreThreshold": 0.3,
      "maxInjectChars": 4000,
      "enabled": true
    }
  }
}
```

### Config reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `geminiApiKey` | string | **required** | Gemini API key (supports `${ENV_VAR}` syntax) |
| `qdrantUrl` | string | `http://qdrant:6333` | Qdrant server URL |
| `qdrantApiKey` | string | — | Qdrant API key (supports `${ENV_VAR}` syntax) |
| `collections` | string[] | `["knowledge_olivier"]` | Qdrant collections to search |
| `topK` | number | `5` | Max results per collection |
| `scoreThreshold` | number | `0.3` | Min similarity score (0-1) |
| `maxInjectChars` | number | `4000` | Max characters injected into prompt |
| `enabled` | boolean | `true` | Enable/disable knowledge injection |

## Qdrant collection requirements

Collections must use:
- **Dimensions**: 3072 (Gemini Embedding 2 Preview default)
- **Distance**: Cosine

Expected payload fields per point:

| Field | Type | Description |
|-------|------|-------------|
| `file_name` | string | Source document name |
| `text` | string | Extracted text content (for the agent to read) |
| `mime_type` | string | Document MIME type |
| `file_id` | string | Google Drive file ID |
| `source` | string | Origin (e.g. `google_drive`) |
| `owner` | string | Document owner |
| `chunk_index` | number | Chunk index (for split documents) |
| `total_chunks` | number | Total chunks in document |
| `timestamp_start` | string | Start time (video/audio segments) |
| `timestamp_end` | string | End time (video/audio segments) |
| `embedded_at` | string | ISO timestamp of indexing |

## Architecture

This plugin is part of a larger knowledge pipeline:

```
Google Drive (documents)
    |
    | n8n ETL (polling every 30 min)
    |
    v
Gemini Embedding 2 Preview (multimodal)  +  Gemini LLM (text extraction)
    |                                          |
    v                                          v
Qdrant vector (3072 dims)                  Qdrant payload (text field)
    |
    | openclaw-knowledge plugin (this repo)
    |
    v
OpenClaw agent context (<relevant-documents>)
```

## Relationship with mem0

This plugin **complements** mem0, it does not replace it:

| | mem0 | openclaw-knowledge |
|---|------|-------------------|
| Purpose | Conversational memory | Document knowledge (RAG) |
| Collection | `memories` | `knowledge_*` (multiple) |
| Source | Facts extracted from chats | Documents from Google Drive |
| Trigger | `autoRecall` (automatic) | `before_agent_start` (automatic) |
| Slot | `memory` (exclusive) | None (coexists freely) |

Both run automatically on every message. The agent receives both `<relevant-memories>` (from mem0) and `<relevant-documents>` (from this plugin) in its context.

## Multi-tenant

Each OpenClaw instance configures its own collection list:

```json
// Olivier's instance
"collections": ["knowledge_olivier", "knowledge_business"]

// Jerome's instance
"collections": ["knowledge_jerome", "knowledge_business"]

// Fabien's instance
"collections": ["knowledge_fabien", "knowledge_business"]
```

## License

MIT
