# openclaw-knowledge-plugin

> **Dual-source knowledge injection plugin for OpenClaw**
> Automatically enriches agent prompts with relevant context from your document knowledge base,
> combining **pgvector semantic search** and **LightRAG knowledge graph** in a single hook.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%E2%89%A5v2026.3.7-blue)](https://github.com/openclaw/openclaw)
[![npm version](https://img.shields.io/npm/v/@lacneu/openclaw-knowledge.svg)](https://www.npmjs.com/package/@lacneu/openclaw-knowledge)

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

### Install via OpenClaw CLI (recommended)

The plugin is published on npm as `@lacneu/openclaw-knowledge`. Use the
official `openclaw plugins` commands — install, update, list, inspect all
work out of the box:

```bash
# Install (pulls the latest version from npm)
openclaw plugins install @lacneu/openclaw-knowledge

# Inspect the installed version and manifest
openclaw plugins inspect @lacneu/openclaw-knowledge

# Update to the latest published version
openclaw plugins update @lacneu/openclaw-knowledge

# List everything installed
openclaw plugins list
```

OpenClaw tracks the install source under `plugins.installs` in your
configuration, so subsequent `update` calls know where to fetch new versions
from.

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
| **Jina integration (optional, v3.2.0+)** | | | |
| `jina.apiKey` | string | — | Jina API key shared by router & reranker (supports `${ENV_VAR}`) |
| `jina.router.enabled` | boolean | `false` | Adaptive routing (skip irrelevant retrievals) |
| `jina.router.mode` | string | `"heuristic"` | `heuristic` (zero-cost) or `jina-classifier` (heuristic + Jina fallback) |
| `jina.router.classifierId` | string | — | Optional pre-trained few-shot classifier ID |
| `jina.pgvectorReranker.enabled` | boolean | `false` | Cross-encoder re-ordering of pgvector results |
| `jina.pgvectorReranker.model` | string | `"jina-reranker-v2-base-multilingual"` | Reranker model |
| `jina.pgvectorReranker.topN` | number | `5` | Max results returned after rerank |
| **TEST mode (optional, v3.2.7+)** | | | |
| `testMode.enabled` | boolean | `false` | Mock BOTH sources — no LightRAG/Postgres connection. **Never enable in production.** |
| `testMode.lightragMockResponse` | string | synthetic context | Canned LightRAG context; `{{query}}` is substituted at runtime |
| `testMode.pgvectorMockResults` | object[] | synthetic hits | Canned pgvector hits (`file_name`, `text`, `score`, `collection`) |
| `testMode.lightragMockReferences` | string[] | synthetic paths | Canned LightRAG source `file_path`s, surfaced through provenance (v3.2.9) |

### LightRAG query modes

| Mode | Description | Best for |
|------|-------------|----------|
| `naive` | Simple vector similarity on chunks | Fast, basic keyword matching |
| `local` | Entity neighborhood traversal | Questions about a specific entity |
| `global` | Community summaries | Broad, overview questions |
| `hybrid` | Combines local + global | **Recommended for most cases** |

### TEST mode — run without LightRAG or Postgres (v3.2.7+)

TEST mode lets you deploy the plugin into an **isolated test environment**
that has **no live LightRAG server and no PostgreSQL/pgvector backend**, while
still observing the plugin's real impact on the agent's answers. Both sources
return canned data, but that data is **genuinely injected** into the agent's
system prompt through the normal `before_prompt_build` → `appendSystemContext`
path — so the agent reasons over it exactly as it would over real retrieval,
and any downstream LLM trace (e.g. the agent's call routed through LiteLLM to
Langfuse) reflects the injected context.

The plugin makes **zero outbound calls** in test mode: no Gemini embedding,
no LightRAG query, and **no pg pool is created**.

```json
{
  "plugins": {
    "entries": {
      "openclaw-knowledge": {
        "enabled": true,
        "config": {
          "collections": ["knowledge_test"],
          "testMode": {
            "enabled": true,
            "lightragMockResponse": "Knowledge-graph context for \"{{query}}\": Projet Hélios, reference HX-2026-0042, owned by équipe Plateforme.",
            "pgvectorMockResults": [
              { "file_name": "guide-helios.md", "text": "Hélios rollout: prep, switch, validation. Ref HX-2026-0042.", "score": 0.87 },
              { "file_name": "faq-helios.md", "text": "Hélios is piloted by équipe Plateforme since 2026-02-14.", "score": 0.72 }
            ],
            "lightragMockReferences": ["guide-helios.md", "faq-helios.md"]
          }
        }
      }
    }
  }
}
```

Notes:

- **No credentials needed.** Under the mock, each source counts as "enabled"
  even without `geminiApiKey` / `lightragUrl`. To mock a **single** source,
  set the other's explicit toggle off (`"pgvectorEnabled": false` or
  `"lightragEnabled": false`) — the explicit disable always wins.
- **Defaults are realistic.** Omit `lightragMockResponse` /
  `pgvectorMockResults` and the plugin injects a synthetic "Projet Hélios"
  knowledge set (with a citable `HX-2026-0042` reference) so you can confirm
  injection worked straight from the agent's reply.
- **`{{query}}`** in `lightragMockResponse` is replaced with the user's query
  at runtime, proving the query travels through the source.
- **`lightragMockReferences`** (v3.2.9) feed the LightRAG **source-attribution
  panel** through provenance — the mock equivalent of real LightRAG
  `references`. On a TEST deployment with `provenanceReport` enabled, users see
  these as the "Sources" behind a LightRAG-grounded answer. Defaults to a small
  synthetic set; set `[]` for no attribution.
- **Mock fidelity divergences** (intentional — the mock path has no DB/Jina):
  - Mock pgvector results **always inject regardless of `scoreThreshold`**
    (the real path filters `score >= scoreThreshold`).
  - The **Jina reranker is bypassed** in test mode (it needs a live endpoint);
    ordering is controlled entirely by the mock `score` values.
- **Router still applies.** The adaptive router (if enabled) runs normally. In
  the default `heuristic` mode it works fully offline; in `jina-classifier`
  mode it would call Jina and fail open to "retrieve" if Jina is unreachable.
  For a fully offline test env, keep the router off or in `heuristic` mode.
- **Safety.** A loud `⚠️ TEST MODE ACTIVE` warning is logged at registration,
  the ready line marks each source `[MOCK]`, and the `lightrag`/`pgvector`
  tracing events carry `mock:true`. **Never enable `testMode` in production** —
  it feeds the agent canned facts it will treat as real.

#### Verifying the impact (Langfuse)

The mock context is genuinely injected, so it reaches the agent's LLM call.
Whether it shows up in **Langfuse** depends on how your test agent is wired:
Langfuse traces calls that go **through LiteLLM** (and the LightRAG server).
A typical production OpenClaw agent routes its chat/reasoning calls **straight
to the model provider** (e.g. `openai-codex`), which Langfuse does **not**
trace — so for Langfuse visibility, the test agent must route its LLM calls
through LiteLLM. The plugin injects correctly either way; this only affects
observability.

End-to-end check that the plugin really influences answers:

1. Deploy with `testMode.enabled: true`.
2. Ask the agent a question answerable **only** from the mock, e.g.
   *"What is the Hélios reference id?"*
3. Confirm the agent answers `HX-2026-0042` (the default mock's citable fact).
   If it does, the injection path works end-to-end.

---

## Jina integration (v3.2.0+)

The plugin can optionally call the [Jina AI](https://jina.ai/) cloud API
to make two improvements:

### Adaptive router — skip retrieval when it can't help

By default the plugin queries every configured source on every turn.
That's wasteful on heartbeats, cron-driven turns, and meta-questions
("what is your session id?") that no knowledge base can answer.

Enabling the router introduces a gating step before the sources are
called:

1. **Zero-cost heuristics first.** Skips on `PluginHookAgentContext.trigger ∈ {heartbeat, cron, memory}`, on
   meta-agent regex matches, and on CLI test pings from
   `messageProvider="cli"`. Keyword fast-paths route obvious factual
   lookups to pgvector and obvious multi-hop questions to LightRAG.
2. **Jina Classifier fallback** (only in `mode: "jina-classifier"`).
   When the heuristics are ambiguous, the plugin calls
   `POST /v1/classify` to pick one of four routes:
   `NONE`, `PGVECTOR_ONLY`, `LIGHTRAG_ONLY`, or `ALL`. **Few-shot
   classifiers MUST be trained against these exact canonical names** —
   any other label is silently rejected and falls back to `ALL`.
   Supports **zero-shot** (built-in labels, no training required) and
   **few-shot** (pre-trained classifier_id, ~50 tokens per call vs ~200
   for zero-shot).
3. **Fail-open.** Any Jina outage degrades silently to `ALL` — the
   pre-3.2.0 behavior. Routing never blocks the agent.

Enable in `openclaw.json`:

```json
"jina": {
  "apiKey": "${JINA_API_KEY}",
  "router": {
    "enabled": true,
    "mode": "heuristic"
  }
}
```

Then switch to `mode: "jina-classifier"` once you're comfortable.

### Pgvector reranker — re-order vector results by relevance

Vector cosine similarity is great recall but mediocre precision: the
top-K candidates are often noisy. A cross-encoder reranker re-scores
each (query, candidate) pair as a pair, which is much more accurate
than independent embeddings — at the cost of one Jina call per turn.

Enable in `openclaw.json`:

```json
"jina": {
  "apiKey": "${JINA_API_KEY}",
  "pgvectorReranker": {
    "enabled": true
  }
},
"topK": 20
```

Recommended `topK ≥ topN × 2` so the reranker has room to re-order.
The plugin warns at init if the ratio is too tight.

**Model default:** `jina-reranker-v2-base-multilingual` — best for
French content. v3 is larger (131K context) but English-biased. Switch
via `jina.pgvectorReranker.model`.

### Observability

Every router decision, source execution, and cooldown transition emits
a structured event line:

```
[knowledge.event] {"type":"router","route":"PGVECTOR_ONLY","reason":"heuristic_keyword","score":null,"queryLength":42,"trigger":"user"}
[knowledge.event] {"type":"pgvector","collections":["knowledge_default"],"rawCount":5,"rerankedCount":5,"topScore":0.78,"durationMs":124}
[knowledge.event] {"type":"lightrag","mode":"hybrid","contextChars":3820,"truncatedChars":3820,"durationMs":210,"sparse":false,"referenceCount":3}
[knowledge.event] {"type":"cooldown","scope":"router","consecutiveErrors":3}
```

These lines can be scraped by Opik, LangFuse, or any OTLP collector
without the plugin depending on a specific tracing SDK.

#### Privacy invariant

The plugin **never** logs any portion of the raw user query, any
retrieved chunk text, any hash of them, or any other potentially-PII
payload. When `logger.debug` is enabled, an extra correlation line
carries the SDK-provided turn identifier only:

```
[knowledge.event] turn.metadata runId=01HF... qlen=42
```

`runId` comes from `PluginHookAgentContext.runId` (the OpenClaw SDK's
non-query-derived turn identifier). `qlen` is just a character count.
The plugin deliberately does NOT publish any hash of the query — a
deterministic SHA-256 prefix of a 3–10 character prompt is
dictionary-recoverable offline, which would defeat the invariant on
exactly the deployments where it matters most (PHI / regulated
content).

Operators who need CONTENT correlation across turns (e.g. "this user
asked the same question twice") must instrument at the SDK layer with
a keyed HMAC and a deployment-side secret; the plugin will not do it
for them.

### Source attribution (provenance, v3.2.8+)

Separately from the tracing events above (which go to logs and **never**
carry content), when `provenanceReport` is `"metadata"` or `"full"` the
plugin emits a **provenance report** on the gateway agent-event bus
(stream `openclaw-knowledge.provenance`), scoped to the chat's own ACL —
so a chat frontend can show the user *which sources fed this reply*:

- **pgvector** items carry `file_name`, `collection`, `score` (and the exact
  injected excerpt at `"full"`).
- **LightRAG** items now carry the **source `file_path`** of each document the
  graph attributed the context to (from LightRAG's `references`, server
  ≥ 1.4.5), plus the single injected-context excerpt at `"full"`. This is the
  hook for letting users deep-dive the exact sources behind a LightRAG-grounded
  answer — the agent can then fetch the verbatim document via a skill.

A reference's retrieved `content` is deliberately never exposed as injected
text (only the truncated, actually-injected blob is), and reports are gated
behind `provenanceReport` — both off by default. Source attribution inherits
the same per-instance LightRAG workspace isolation as the context itself.

### Cooldown isolation

The pre-existing 3-errors → 5-min cooldown is now split into three
independent counters:

| Scope | Triggers cooldown |
|-------|-------------------|
| `global` | Both pgvector AND LightRAG fail in the same turn |
| `router` | Repeated Jina classifier errors |
| `pgvector_reranker` | Repeated Jina rerank errors |

A Jina outage on one path no longer affects the others.

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
   - Compile TypeScript (`npm run build`)
   - **Publish `@olivierneu/openclaw-knowledge` to npm** (public access)
   - Create a GitHub Release with changelog notes extracted from `CHANGELOG.md`

#### Required GitHub secret

The workflow needs an `NPM_TOKEN` secret. Because the npm account has 2FA
enabled with a security key, the token **must** be an **Automation token**
(not a regular Publish token), because automation tokens bypass 2FA for CI/CD.

Generate it on npm: *Access Tokens → Generate New Token → Classic Token →
Automation*, then add it under GitHub repo *Settings → Secrets and variables
→ Actions* as `NPM_TOKEN`.

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
