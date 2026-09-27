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

Both sources run **in parallel** under a per-turn latency budget, so a slow or
failing source never blocks the other (or the agent). Since **v4.0** the result is
injected on the **current user message** (`prependContext`) rather than the system
prompt, which keeps the system prompt and the conversation prefix byte-stable so
provider **prompt caching** keeps working across turns.

v4.0 also adds named sources, per-agent / per-session / per-prompt policies (driven
by Atrium, the `/knowledge` chat command or Gateway RPC), an on-demand
`knowledge_search` tool, a per-session cache and a `timing` event per turn — see
[Latency, caching and control plane (v4.0)](#latency-caching-and-control-plane-v40)
and [docs/atrium-integration.md](docs/atrium-integration.md).

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
3. Query text is extracted (`currentUserMessage` when the host provides it) and
   validated (≥ 3 characters)
4. **Skip stage (v4.0):** sub-agent / active-memory sessions, heartbeat / cron /
   memory / manual triggers, non-human input (typed `inputProvenance`) and bare
   acknowledgements ("merci", "ok parfait") stop here — no network call
5. **Effective policy (v4.0):** one-shot > session override > agent > default
   decides the injection mode (`auto` / `tool` / `hybrid` / `off`) and the sources
6. **Router** (optional): heuristics, then the Jina classifier — serially or in
   parallel with speculative source calls (`jina-classifier-parallel`)
7. **Sources in parallel**, each under its own timeout and the global
   `retrievalBudgetMs`:
   - **pgvector path:** embed query via Gemini → SQL search on `knowledge_vectors`
   - **LightRAG path:** POST `/query` with a per-route mode (`naive` for simple
     lookups, `hybrid` for graph questions), optionally with local keywords
8. Finished results are truncated per source and wrapped in a
   `<relevant-documents>` block injected via `prependContext` (configurable)
9. A `timing` event summarizes the turn; provenance reports are emitted only if
   the host is still awaiting the handler
10. The agent receives the enriched user turn and generates its response

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
| `lightragQueryMode` | string | `"hybrid"` | Legacy global mode (`naive`, `local`, `global`, `hybrid`, `mix`). When set explicitly it overrides every per-route default (v4.0) |
| `lightragMaxChars` | number | `4000` | Character budget for LightRAG context |
| `lightragEnabled` | boolean | `true` if `lightragUrl` set | Disable LightRAG while keeping pgvector |
| **Jina integration (optional, v3.2.0+)** | | | |
| `jina.apiKey` | string | — | Jina API key shared by router & reranker (supports `${ENV_VAR}`) |
| `jina.router.enabled` | boolean | `false` | Adaptive routing (skip irrelevant retrievals) |
| `jina.router.mode` | string | `"heuristic"` | `heuristic` (zero-cost), `jina-classifier` (heuristic + Jina fallback, serial) or `jina-classifier-parallel` (v4.0, sources start while the classifier runs) |
| `jina.router.timeoutMs` | number | `1500` | Jina classify timeout (v4.0); fails open to `ALL` |
| `jina.router.classifierId` | string | — | Optional pre-trained few-shot classifier ID |
| `jina.pgvectorReranker.enabled` | boolean | `false` | Cross-encoder re-ordering of pgvector results |
| `jina.pgvectorReranker.model` | string | `"jina-reranker-v2-base-multilingual"` | Reranker model |
| `jina.pgvectorReranker.topN` | number | `5` | Max results returned after rerank |
| **Latency & injection (v4.0)** | | | |
| `injectionTarget` | string | `"prependContext"` | `prependContext` / `appendContext` (user turn, cache-friendly) or `appendSystemContext` (pre-4.0) |
| `retrievalBudgetMs` | number | `4500` | Global per-turn budget (router + sources); partial results are injected when it elapses |
| `lightragTimeoutMs` | number | `3500` | Abort a LightRAG `/query` call |
| `pgvectorTimeoutMs` | number | `3000` | Abort the Gemini embedding + SQL path (also PostgreSQL `statement_timeout`) |
| `hookTimeoutMs` | number | budget + 1500 | Explicit `before_prompt_build` timeout registered with the host |
| `lightragQueryModeByRoute` | object | see below | Per-route LightRAG mode (`PGVECTOR_ONLY`, `LIGHTRAG_ONLY`, `ALL`, `fallback`, `tool`) |
| `lightragLocalKeywords` | boolean | `false` | Send locally extracted `hl_keywords` / `ll_keywords` so LightRAG skips its LLM keyword extraction |
| `skip.sessionPatterns` | string[] | `[":subagent:", ":active-memory:"]` | Session-key substrings that skip retrieval |
| `skip.triggers` | string[] | `["heartbeat","cron","memory","manual"]` | Triggers that skip retrieval (`[]` = pre-4.0) |
| `skip.nonHumanInput` | boolean | `true` | Skip `inter_session` / `internal_system` input (typed provenance) |
| `skip.allowSourceTools` | string[] | `[]` | Provenance `sourceTool`s still retrieved |
| `skip.acknowledgements` | boolean | `true` | Skip whole-message greetings / thanks / confirmations on every channel |
| `cache.enabled` / `ttlMs` / `maxEntries` / `maxBytes` | | `true` / 10 min / 200 / 8 MiB | Per-session result cache |
| **Sources & policies (v4.0)** | | | |
| `sources` | object | synthesized | Named sources `id → {type, label, description, enabled, url, apiKey, collections, queryMode, maxChars}` |
| `defaults` | object | auto + all sources | Global default policy `{injection, sources, allowedSources, topK, lightragQueryMode, allowSessionOverrides}` |
| `agents` | object | — | Per-agent policy keyed by agent id (same shape as `defaults`) |
| `hybridMinScore` | number | `0.45` | Classifier score required to auto-inject under `hybrid` |
| `tool.enabled` / `defaultTopK` / `maxTopK` | | `true` / — / `20` | `knowledge_search` tool (optional tool: allowlist it) |
| `controlPlane.sessionOverrides` / `oneShotTtlMs` / `command` / `gatewayMethods` | | `true` / 10 min / `true` / `true` | Atrium & chat control plane |
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
| `mix` | Knowledge graph + vector chunks | Broad questions (LightRAG ≥ 1.3) |

`local`, `global`, `hybrid` and `mix` start with an **LLM keyword-extraction call**
inside LightRAG; `naive` does not. Since v4.0 the mode is chosen per route:

| Route key | Default | When |
|-----------|---------|------|
| `PGVECTOR_ONLY` | `naive` | The router judged the turn a simple lookup (applies to LightRAG when pgvector is not available) |
| `LIGHTRAG_ONLY` | `hybrid` | Graph question |
| `ALL` | `hybrid` | Broad question / router disabled (pre-4.0 behavior) |
| `fallback` | `hybrid` | `ALL` reached through `classifier_fallback` / `classifier_low_confidence` / `classifier_error` |
| `tool` | `naive` | `knowledge_search` calls without an explicit `mode` |

Precedence (highest first): explicit policy / tool `mode` → explicit
`lightragQueryModeByRoute[route]` → source `queryMode` → legacy `lightragQueryMode`
(when set, it replaces every built-in default) → built-in defaults above.

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

## Latency, caching and control plane (v4.0)

### Cache-friendly injection

Pre-4.0 the knowledge block was appended to the **system prompt** — which changed on
every turn and invalidated the provider's cached prefix (system prompt + whole
history). 4.0 injects it on the **current user message** (`prependContext`): OpenClaw
rewrites only the active user prompt for model submission and keeps the raw user
text in the transcript, so the system prompt and every previous turn stay
byte-identical and cacheable. Set `injectionTarget: "appendSystemContext"` to restore
the old placement. Provenance reports carry the actual position
(`user_prepend`, `user_append`, `system_append`, `tool_result`).

### Non-human turns are skipped first

| Signal | Default | Reason in the `router` event |
|--------|---------|------------------------------|
| `ctx.sessionKey` contains `:subagent:` / `:active-memory:` | skip | `skip_subagent_session` |
| `ctx.trigger` ∈ heartbeat, cron, memory, manual | skip | `heuristic_trigger` |
| `ctx.inputProvenance.kind` present and ≠ `external_user` | skip | `skip_non_human_input` |
| Whole message is a greeting / thanks / confirmation (FR+EN, ≤ 48 chars) | skip | `heuristic_ack` |

These run on every deployment, router enabled or not. Absent provenance is treated
as human (the host omits it on some human paths).

### Time budgets and partial success

Every source runs under an `AbortSignal` (`lightragTimeoutMs`, `pgvectorTimeoutMs`,
`jina.router.timeoutMs`) **and** the global `retrievalBudgetMs`. When the budget
elapses, the hook injects what already finished, logs a warning and flags
`budgetExceeded` in the `timing` event. The hook is registered with an explicit
`timeoutMs` (`hookTimeoutMs`, default budget + 1.5 s) instead of the host's 15 s
default, and the handler checks `ctx.hookInvocation.assertActive()` before emitting
provenance so a late result never reports sources that were not used. Turns where
every source merely timed out do not count toward the global 3-errors cooldown.
Note that an aborted LightRAG request may keep running server-side until LightRAG
finishes it.

### Router: `jina-classifier-parallel`

`jina-classifier` waits for the Jina call before launching any source (latency =
classifier + sources). `jina-classifier-parallel` launches the selected sources
speculatively (with the `fallback` mode) while the classifier runs, then keeps them,
trims them to the decided route, re-launches LightRAG if the confident route needs a
different mode, or discards everything on `NONE`. **Tradeoff:** turns end ≈ one
classifier round-trip earlier, but every ambiguous turn pays a retrieval, including
the ones the classifier would have skipped (`speculativeDiscarded` in the `timing`
event counts the waste). Heuristic decisions (keywords, skips) never speculate.

### Per-session cache

Results are cached per `(agentId, sessionKey, normalized query, source, variant)`
for `cache.ttlMs` (10 min), bounded by entry count and bytes (LRU). Only sessions
with a `sessionKey` are cached; a policy change and a session reset / delete purge
the session's entries. `cacheHit` in the `timing` event counts hits.

### Named sources and policies

```json5
"sources": {
  "graph": { "type": "lightrag", "label": "Graphe de connaissances", "url": "http://openclaw-lightrag-jerome:9621" },
  "docs":  { "type": "pgvector", "label": "Documents", "collections": ["knowledge_jerome"] }
},
"defaults": { "injection": "auto", "sources": ["graph", "docs"] },
"agents": {
  "denis": { "injection": "hybrid", "sources": ["docs"], "allowedSources": ["graph", "docs"] },
  "files": { "injection": "tool" },
  "meta":  { "injection": "off" }
}
```

Without `sources`, the legacy keys are synthesized into ids `pgvector` and
`lightrag` (existing configs keep working unchanged). Injection policies:

| Policy | Behavior |
|--------|----------|
| `auto` | Retrieve and inject on every eligible turn (pre-4.0) |
| `hybrid` | Inject only on a heuristic keyword hit or a classifier hit ≥ `hybridMinScore`; otherwise the model uses the tool |
| `tool` | Never inject; the model calls `knowledge_search` when it needs to |
| `off` | Nothing is injected and the tool refuses |

Effective policy per turn: **one-shot > session override > agent > defaults**. A
session / one-shot selection is always clamped to the agent's `allowedSources`
(re-validated on every read) — a client can never reach a source its agent is not
entitled to.

### `knowledge_search` tool

An **optional** agent tool (manifest `toolMetadata.knowledge_search.optional`), so
enable it explicitly, globally or per agent:

```json5
"tools": { "alsoAllow": ["lobster", "knowledge_search"] }
// or: "agents": { "entries": { "files": { "tools": { "alsoAllow": ["knowledge_search"] } } } }
```

Parameters: `query` (required), `sources`, `collection`, `mode`
(`naive|local|global|hybrid|mix`), `topK`. It uses the same allowlist, cache and
renderers as the hook, defaults to LightRAG `naive`, allows longer calls (15 s
LightRAG / 20 s total) and attaches provenance to the current run.

### Control plane: Atrium, `/knowledge`, Gateway

| Surface | Name | Scope |
|---------|------|-------|
| Session extension | session rows: `pluginExtensions[] = {pluginId: "openclaw-knowledge", namespace: "policy", value}` | read with the (non-lightweight) row |
| Session action | `plugins.sessionAction` `policy.get` / `policy.set` / `policy.reset` | `operator.read` / `operator.write` |
| Gateway method | `knowledge.sources`, `knowledge.policy.get` | `operator.read` |
| Raw write (admin) | `sessions.pluginPatch` (namespace `policy`) | `operator.admin` |
| Chat command | `/knowledge [status|auto|hybrid|tool|off|use <ids>|once <ids>|reset]` | authorized senders |

The full contract is in [docs/atrium-integration.md](docs/atrium-integration.md).

### Observability in Opik

```json5
"opik": { "enabled": true, "workspace": "my-workspace", "projectName": "openclaw-prod" }
// apiKey defaults to OPIK_API_KEY; apiUrl defaults to Opik Cloud
```

Each retrieval is exported as a `knowledge.retrieval` (hook) or `knowledge.search`
(tool) trace with `router`, `lightrag:<id>` and `pgvector:<id>` spans, tagged
`agent:<id>`, `route:<route>`, `injected` / `not-injected`, `budget-exceeded`, and
correlated to the agent run by `metadata.runId`. Payloads are content-free (no query,
retrieved text, document path or session key). For end-to-end turn latency, enable
OpenClaw's `diagnostics-otel` plugin with Opik's OTLP endpoint
(`https://www.comet.com/opik/api/v1/private/otel/v1/traces`, headers `Authorization`,
`Comet-Workspace`, `projectName`) — both land in the same Opik project.

### Migrating from 3.x

Existing configs load unchanged. Behavior changes to be aware of:

1. The knowledge block moves from the system prompt to the user turn
   (`injectionTarget: "appendSystemContext"` restores it).
2. Heartbeat / cron / memory / manual turns, sub-agent sessions, non-human input
   and bare acknowledgements are skipped even with the router disabled
   (`skip.*` restores the old behavior).
3. Without an explicit `lightragQueryMode`, simple lookups and tool calls use
   `naive`; set `lightragQueryMode: "hybrid"` to keep one mode everywhere.
4. LightRAG / pgvector calls are aborted after 3.5 s / 3 s and the whole turn after
   4.5 s (raise `retrievalBudgetMs` & co. if your sources are slower).
5. `knowledge_search` exists but is not exposed until allowlisted.

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

1. **Zero-cost heuristics first.** (Since v4.0 the trigger / sub-agent /
   provenance / acknowledgement skips run before the router on every deployment —
   see [Non-human turns are skipped first](#non-human-turns-are-skipped-first).)
   Skips on `PluginHookAgentContext.trigger ∈ {heartbeat, cron, memory}`, on
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

Then switch to `mode: "jina-classifier"` once you're comfortable, or to
`"jina-classifier-parallel"` (v4.0) to overlap the classifier with the sources.

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
[knowledge.event] {"type":"timing","runId":"01J…","agentId":"jerome","filterMs":1,"routerMs":412,"pgvectorMs":380,"lightragMs":2210,"totalMs":2640,"route":"ALL","reason":"classifier_low_confidence","skipped":null,"cacheHit":0,"budgetExceeded":false,"injected":true,"injectionTarget":"prependContext","policy":{"injection":"auto","sources":["graph","docs"],"origin":{"injection":"agent","sources":"agent"}}}
```

Since v4.0 each eligible turn (≥ 3 chars) emits exactly one `timing` line with the
per-stage durations, the route / reason, why retrieval was skipped (`skipped`), cache
hits, `budgetExceeded`, speculative waste and the resolved policy. Pre-router skips
also emit a `router` event (`route: "NONE"`) with a content-free `detail` (matched
pattern, trigger or `kind:sourceTool`). No session key is logged (it can embed a
channel peer id).

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
│   ├── index.ts               # Entry point (definePluginEntry + register) + hook handler
│   ├── config.ts              # resolveEnv + default resolution (sources, policies, budgets)
│   ├── skip.ts                # Pre-router non-human turn filter (4.0)
│   ├── policy.ts              # Policy resolution, session-state validation, /knowledge parser (4.0)
│   ├── retrieval.ts           # Source runners, budgets, rendering (shared by hook + tool) (4.0)
│   ├── control-plane.ts       # Session extension, session actions, Gateway methods, command (4.0)
│   ├── tool.ts                # knowledge_search agent tool (4.0)
│   ├── cache.ts               # Per-session LRU result cache (4.0)
│   ├── keywords.ts            # Local LightRAG keyword extraction (4.0)
│   ├── cooldown.ts            # Circuit breakers
│   ├── embeddings.ts          # Gemini embedContent client
│   ├── pgvector.ts            # PostgreSQL search + result formatter
│   ├── lightrag.ts            # LightRAG client + truncation
│   ├── provenance.ts          # provenance/v1 reports
│   ├── router/ jina/ tracing/ # Router, Jina clients, structured events
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
| `retrieval budget … exceeded — returning partial results` | A source is slower than `retrievalBudgetMs` | Check the `timing` event (`lightragMs`); use `naive` / `lightragLocalKeywords`, or raise the budget |
| `LightRAG query timed out after 3500ms` | LightRAG LLM keyword extraction is slow | `lightragQueryModeByRoute`, `lightragLocalKeywords: true`, or raise `lightragTimeoutMs` |
| `knowledge_search` never called | Optional tool not allowlisted | Add it to `tools.alsoAllow` (global or per agent) |
| No retrieval on a turn | Skipped as non-human / acknowledgement / policy | See `skipped` in the `timing` event and `reason` in the `router` event |

---

## License

MIT — see [LICENSE](LICENSE)
