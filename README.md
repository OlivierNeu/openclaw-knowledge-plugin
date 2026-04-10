# openclaw-knowledge-plugin

> **Dual-source knowledge injection plugin for OpenClaw**
> Automatically enriches agent prompts with relevant context from your document knowledge base,
> combining **pgvector semantic search** and **LightRAG knowledge graph** in a single hook.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A5v2026.3.7-blue)](https://github.com/openclaw/openclaw)
[![Version](https://img.shields.io/badge/version-3.0.4-green)](CHANGELOG.md)

---

## Overview

`openclaw-knowledge` is an OpenClaw plugin that automatically injects relevant
documents and knowledge graph context into every agent turn. It hooks into
`before_prompt_build` and queries **two complementary sources in parallel**:

| Source | Technology | What it provides |
|--------|------------|------------------|
| **pgvector** | PostgreSQL + `pgvector` extension | Semantic vector search on document chunks (cosine similarity on 3072-dim embeddings) |
| **LightRAG** | Neo4j + PostgreSQL | Knowledge graph with entity/relation multi-hop traversal |

Both sources run **in parallel** via `Promise.allSettled`, so a failure in one
source doesn't block the other. Results are merged and injected into the agent's
system prompt via `appendSystemContext`.

---

## Why two sources?

Vector search and knowledge graphs answer different kinds of questions:

- **Vector search** finds passages that are **semantically similar** to the query.
  Good for "What did the meeting say about pricing?" — matches embeddings.
- **Knowledge graph** finds entities and **their relationships**.
  Good for "Which clients work in the insurance sector?" — traverses entity links.

Running both gives the agent both capabilities simultaneously, without requiring
the LLM to decide which to use.

---

## Architecture

![System architecture](schemas/system-architecture.png)

The plugin is the **query layer** of a larger knowledge pipeline:

1. **Ingestion (background, via n8n):** Google Drive documents are polled,
   OCR'd via Mistral, embedded via Gemini, and stored in PostgreSQL (`pgvector`)
   and Neo4j (LightRAG knowledge graph).
2. **Query (real-time, via this plugin):** Every user message triggers a
   parallel search in both sources, results are formatted and prepended to
   the agent's prompt.

The plugin does **not** handle ingestion — that's the responsibility of the n8n
ETL pipeline. This plugin only reads from the existing data stores.

---

## Query lifecycle

![Runtime sequence](schemas/runtime-sequence.png)

Every user message triggers the following sequence:

1. OpenClaw fires `before_prompt_build` with the user's prompt
2. The plugin checks its **cooldown state** (pauses 5 min after 3 consecutive errors)
3. Query text is extracted and validated (≥ 3 characters)
4. **In parallel** (`Promise.allSettled`):
   - **pgvector path:** embed query via Gemini → SQL search on `knowledge_vectors`
   - **LightRAG path:** POST `/query` with `mode=hybrid` to the LightRAG server
5. Results are merged and truncated to `maxInjectChars`
6. Formatted blocks (`### Document Search Results` + `### Knowledge Graph Context`)
   are injected via `appendSystemContext`
7. The agent receives the enriched prompt and generates its response

---

## Decision flow

![Plugin lifecycle](schemas/plugin-lifecycle-flowchart.png)

The plugin implements several safeguards to ensure it never blocks the agent:

| Safeguard | Purpose |
|-----------|---------|
| **Cooldown** (3 errors → 5 min pause) | Avoid log spam and unnecessary API calls during outages |
| **Query length check** (≥ 3 chars) | Skip meaningless searches |
| **`Promise.allSettled`** for sources | A failure in one source doesn't affect the other |
| **Silent error handling** | Errors are logged but never thrown to the agent |
| **Gracefull degradation** | If both sources fail, the agent runs as if the plugin weren't there |

---

## Installation

### Requirements

- OpenClaw ≥ `v2026.3.7` (for `before_prompt_build` hook)
- PostgreSQL with `pgvector` extension
- LightRAG server (optional — plugin works with pgvector alone)
- Gemini API key (for query embedding)

### From GitHub Release (recommended)

Dependencies (`pg`) are **bundled in the release tarball since v3.0.4** — no
`npm install` required at deployment time.

```bash
# Download the latest release
VERSION=3.0.4
curl -sfL "https://github.com/OlivierNeu/openclaw-knowledge-plugin/releases/download/v${VERSION}/openclaw-knowledge-${VERSION}.tar.gz" \
  -o /tmp/openclaw-knowledge.tar.gz

# Extract into OpenClaw extensions
tar -xzf /tmp/openclaw-knowledge.tar.gz -C /path/to/.openclaw/extensions/

# Verify
ls /path/to/.openclaw/extensions/openclaw-knowledge/
# → index.js  LICENSE  node_modules/  openclaw.plugin.json  package.json
```

### Automated multi-tenant deployment

The `update-knowledge-plugin.sh` script (available in the OpenClaw stack repo)
fetches the latest release and deploys it to all configured instances:

```bash
sudo /path/to/update-knowledge-plugin.sh
```

It checks the installed version against the latest GitHub release, downloads
the tarball once, deploys to all instances, and restarts affected containers.

### Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["openclaw-knowledge", "hindsight-openclaw", "telegram"],
    "entries": {
      "openclaw-knowledge": {
        "enabled": true,
        "config": {
          "geminiApiKey": "${GEMINI_API_KEY}",
          "postgresUrl": "postgresql://user:${POSTGRES_PASSWORD}@postgresql:5432/knowledge",
          "collections": ["knowledge_alice"],
          "topK": 5,
          "scoreThreshold": 0,
          "maxInjectChars": 4000,
          "lightragUrl": "http://lightrag:9621",
          "lightragApiKey": "${LIGHTRAG_API_KEY}",
          "lightragQueryMode": "hybrid",
          "lightragMaxChars": 4000
        }
      }
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

---

## Configuration reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch for the plugin |
| **pgvector source** | | | |
| `geminiApiKey` | string | — | Gemini API key for query embedding (supports `${ENV_VAR}`) |
| `postgresUrl` | string | — | PostgreSQL connection URL (supports `${ENV_VAR}`) |
| `collections` | string[] | `["knowledge_default"]` | Collections to search in `knowledge_vectors` table |
| `topK` | number | `5` | Max results per collection |
| `scoreThreshold` | number | `0.3` | Minimum cosine similarity (0–1) |
| `maxInjectChars` | number | `4000` | Character budget for pgvector results |
| `pgvectorEnabled` | boolean | `true` if `geminiApiKey` set | Disable pgvector while keeping LightRAG |
| **LightRAG source** | | | |
| `lightragUrl` | string | — | LightRAG server base URL |
| `lightragApiKey` | string | — | LightRAG API key (supports `${ENV_VAR}`) |
| `lightragQueryMode` | string | `"hybrid"` | Query mode: `naive`, `local`, `global`, `hybrid` |
| `lightragMaxChars` | number | `4000` | Character budget for LightRAG context |
| `lightragEnabled` | boolean | `true` if `lightragUrl` set | Disable LightRAG while keeping pgvector |

### LightRAG query modes

| Mode | Description | Best for |
|------|-------------|----------|
| `naive` | Simple vector similarity on chunks | Fast, basic keyword matching |
| `local` | Entity neighborhood traversal | Questions about a specific entity |
| `global` | Community summaries | Broad, overview questions |
| `hybrid` | Combines local + global | **Recommended for most cases** |

---

## Data model

### pgvector: `knowledge_vectors` table

The plugin expects a PostgreSQL table with this structure:

```sql
CREATE TABLE knowledge_vectors (
  id SERIAL PRIMARY KEY,
  collection TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  text TEXT,
  file_id TEXT,
  source TEXT,
  owner TEXT,
  chunk_index INTEGER,
  total_chunks INTEGER,
  timestamp_start TEXT,
  timestamp_end TEXT,
  embedded_at TIMESTAMPTZ,
  embedding vector(3072) NOT NULL
);

CREATE INDEX idx_knowledge_vectors_hnsw
  ON knowledge_vectors
  USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
```

**Important:** The HNSW index must use `halfvec(3072)` because pgvector's HNSW
index has a 2000-dimension limit for the native `vector` type. `halfvec`
supports up to 4000 dimensions. The plugin query casts both the column and the
parameter accordingly.

### Embeddings

- **Model:** `gemini-embedding-2-preview` via the native Gemini API
- **Dimensions:** 3072
- **Distance metric:** cosine similarity
- **Query endpoint:** the plugin uses the **native** `embedContent` endpoint
  (not the OpenAI-compatible one), because the native endpoint supports
  multimodal embedding at ingestion time while still working for text queries.

### LightRAG query

The plugin sends a POST request:

```http
POST /query HTTP/1.1
X-API-Key: <lightragApiKey>
Content-Type: application/json

{
  "query": "<user message>",
  "mode": "hybrid",
  "only_need_context": true
}
```

`only_need_context: true` tells LightRAG to return the retrieved context
**without** running the final LLM synthesis — the plugin only needs the
raw context to inject into the agent's prompt.

---

## Multi-tenant support

Each OpenClaw instance can configure its own set of collections:

```json
// Alice's instance
"collections": ["knowledge_alice", "knowledge_shared"]

// Bob's instance
"collections": ["knowledge_bob", "knowledge_shared"]
```

All instances can share the same PostgreSQL database — isolation is done
at the collection level. LightRAG, however, uses one instance per tenant
(workspace isolation is not yet exposed in the plugin).

---

## Example output

When the agent receives a user message, it sees something like this in its system prompt:

```
<existing system prompt>

### Document Search Results (pgvector)

[knowledge_alice] Contrat_Acme_Corp.pdf (score: 0.92, chunk 2/5)
Service agreement between Alice Consulting and Acme Corp. Duration: 6 months,
daily rate: 1500 EUR, start date: 2026-01-15, deliverables: strategy workshops,
CODIR alignment sessions, monthly follow-ups...

[knowledge_shared] Pricing_Grid_2026.pdf (score: 0.87, chunk 1/1)
Standard pricing grid: senior consulting 1500 EUR/day, junior 900 EUR/day,
workshops 3500 EUR/day flat...

### Knowledge Graph Context (LightRAG)

Entity: Acme Corp (Organization)
  Relationships:
  - Acme Corp → client_of → Alice Consulting (since 2026-01-15)
  - Acme Corp → subject_of → Contrat_Acme_Corp.pdf
  - Acme Corp → operates_in → Insurance sector
  - Acme Corp → represented_by → Thomas Martin (Contact)

User: What were the terms of the Acme contract?
```

The LLM can now cite both the vector search hits (specific text passages) and
the knowledge graph entities (relationships and structure) to produce a
grounded answer.

---

## Relationship with Hindsight

This plugin **complements** [Hindsight](https://github.com/vectorize-io/hindsight)
(the memory plugin) without conflict:

| | Hindsight | openclaw-knowledge |
|---|-----------|-------------------|
| **Purpose** | Conversational memory | Document knowledge (RAG) |
| **Source** | Facts extracted from chats | Documents from Google Drive |
| **Storage** | PostgreSQL (Hindsight schema) | PostgreSQL (`knowledge_vectors`) + Neo4j |
| **Trigger** | `auto-recall` on every message | `before_prompt_build` on every message |
| **Injection block** | `<relevant-memories>` | `### Document Search Results` + `### Knowledge Graph Context` |
| **OpenClaw slot** | `memory` (exclusive) | None (coexists freely) |

Both run on every user message. The agent receives **both** blocks, giving it
conversational memory AND document knowledge simultaneously.

---

## Development

This plugin is written in **TypeScript** and builds against the official
OpenClaw plugin SDK (`openclaw/plugin-sdk/plugin-entry`).

### Project layout

```
openclaw-knowledge-plugin/
├── src/                       # TypeScript source
│   ├── index.ts               # Entry point (definePluginEntry + register)
│   ├── config.ts              # resolveEnv + default resolution
│   ├── embeddings.ts          # Gemini embedContent client
│   ├── pgvector.ts            # PostgreSQL search + result formatter
│   ├── lightrag.ts            # LightRAG client + truncation
│   └── types.ts               # Shared interfaces
├── test/                      # TypeScript test suites (node:test)
├── dist/                      # Compiled JS + .d.ts (gitignored)
├── tsconfig.json              # Strict TS config for src
├── tsconfig.test.json         # Typecheck (src + test)
├── tsconfig.test-build.json   # Compile tests to dist-test/ for node:test
├── openclaw.plugin.json       # Plugin manifest (config schema + uiHints)
└── package.json
```

### Build and test

```bash
# Install dev dependencies (includes the openclaw SDK for types, ~200 MB)
npm install

# Strict type check (src + tests)
npm run typecheck

# Run the full test suite (compiles tests then runs node:test)
npm test

# Compile TS → dist/
npm run build

# Clean build output
npm run clean
```

### Release process

1. Update `CHANGELOG.md` with the new version (add a `## [x.y.z] - YYYY-MM-DD` section)
2. Commit the changelog update
3. Create and push a git tag:
   ```bash
   git tag v3.1.0
   git push origin v3.1.0
   ```
4. GitHub Actions will automatically:
   - Run `npm run typecheck`, `npm test`, `npm run build` on Node.js 24
   - Stamp the version from the tag into `package.json` and `openclaw.plugin.json`
   - Install full dev dependencies and compile TypeScript (`npm run build`)
   - Prune to production dependencies (`npm install --omit=dev`)
   - Create a tarball containing `dist/`, `package.json`, `openclaw.plugin.json`,
     `LICENSE`, `README.md`, and `node_modules/`
   - Publish the release with changelog notes extracted from `CHANGELOG.md`

The release tarball is self-contained: extract it into
`.openclaw/extensions/openclaw-knowledge/` and the plugin is ready to use.
`node_modules/` is bundled so no `npm install` is required at deployment time.

---

## Troubleshooting

| Symptom | Cause | Solution |
|---------|-------|----------|
| `Cannot find module 'pg'` | Old release (pre-v3.0.4) without bundled deps | Upgrade to v3.0.4+ |
| `neither pgvector nor LightRAG configured — plugin disabled` | No `geminiApiKey` and no `lightragUrl` | Configure at least one source |
| `pgvector — source failed: Gemini embedding failed (429)` | Gemini quota exceeded | Check Gemini API quotas or back off |
| `LightRAG query failed (401)` | Wrong or missing `lightragApiKey` | Verify the header `X-API-Key` is accepted |
| `LightRAG query failed (503)` | LightRAG server down | Check LightRAG container status |
| Plugin loads but no context injected | `scoreThreshold` too high | Lower to `0` to see all matches |
| Plugin enters 5-min cooldown | 3 consecutive errors on all sources | Check logs, fix the underlying issue |

---

## License

MIT — see [LICENSE](LICENSE)
