# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.2] - 2026-05-23

### Fixed — Jina classifier silently blocked retrieval on low-confidence scores

After v3.2.1 fixed query extraction, jerome's production traces showed
that 6 out of 8 user turns ended up with `route=NONE` from
`reason=classifier_hit` with scores tightly clustered around **0.25**:

```
0.2540  0.2559  0.2642  0.2507  0.2630  0.2516
```

This pattern is the Jina v3 zero-shot **noise floor** — when no label
actually matches the query, the engine still picks the closest one (most
often `NONE` because its label happens to be embedded first), but the
decision is essentially random. The previous router code trusted any
prediction regardless of score, so the classifier silently blocked
retrieval on legitimate questions.

Confirmed regression scenario, from a real chat-export on 2026-05-23:

> Query: `"Quel est l'arbitrage principal de la réunion hebdomadaire
>         Ataraxis du 19 mai 2026 ?"`
> Classifier: `NONE @ 0.25` → router blocked the RAG.
> The agent then recovered via the `gworkspace-search` skill, but the
> RAG never contributed and the turn took 43 s + 5 tool calls instead
> of one direct injection.

### Low-confidence guard

`decideRoute` now requires the classifier score to clear a configurable
`minConfidence` threshold (default `0.35`). Below the floor, the router
fails open to `ALL` with reason `classifier_low_confidence`. A `null`
score (Jina omitted the field) also triggers the fallback — we cannot
prove confidence.

Why `0.35`:
- Observed noise floor: 0.25–0.27 across all six false `NONE` hits.
- Observed real hits: typically 0.40–0.65 on Jina v3 zero-shot with
  the descriptive built-in labels.
- A 0.35 floor catches the noise band without rejecting clear matches.

The threshold is exposed at:
- `RouterConfig.minConfidence` (internal API)
- `RouterPluginConfig.minConfidence` (user config, `[0, 1]`)
- `ResolvedKnowledgeConfig.routerMinConfidence` (resolved + clamped)
- `jina.router.minConfidence` in `openclaw.plugin.json` config schema

`resolveConfig` clamps the resolved value into `[0, 1]` defensively;
non-finite inputs collapse to `0` (the legacy / pre-3.2.2 behavior).

### Logging discrimination

`RouterReason` adds `classifier_low_confidence` so dashboards can tell
"the classifier confidently said NONE" from "the classifier had no
signal at all". Both flow into the same fail-open route (`ALL`), but
the distinction matters when tuning labels or training a few-shot
classifier — only `classifier_low_confidence` should drive label work.

### Migration

Drop-in patch. No config change required to activate the floor — the
default takes effect immediately. To recover the pre-3.2.2 behavior
explicitly (e.g. for an evaluation A/B), set
`jina.router.minConfidence: 0` via `openclaw config set`.

```bash
sudo docker exec openclaw-jerome openclaw plugins update @lacneu/openclaw-knowledge
sudo docker exec openclaw-olivier openclaw plugins update @lacneu/openclaw-knowledge
sudo docker restart openclaw-jerome openclaw-olivier
```

After restart, watch the `[knowledge.event]` router lines: previously
all-`NONE` low-confidence noise should turn into `route=ALL`,
`reason=classifier_low_confidence`. Counts of true `classifier_hit`
decisions stay unchanged (high-confidence scores still pass through).

### Public-API safety (Codex pass #25)

`decideRoute` now applies the default + clamp **at function entry**
rather than relying on the caller. Previously, a legacy JS plugin
using the public export `decideRoute` without supplying the new
`minConfidence` field would have silently bypassed the guard
(`score < undefined` is `false` in JS, so every prediction would have
been treated as confident). The interface field is now declared
optional, and the function defaults to `DEFAULT_MIN_CONFIDENCE` (also
exported for callers who want to read the floor explicitly).

The clamp helper inside `decideRoute` also defends against misconfigured
negative thresholds — a negative value would have made every score
clear the floor, defeating the guard.

### Test coverage

- Total: 232 tests, all green (was 223 in 3.2.1; +9 new).
- 7 new tests in `test/router/router.test.ts` covering the Ataraxis
  regression scenario, the exact boundary (`score === minConfidence`
  passes), a clear-match scenario above threshold, the few-shot path,
  the `minConfidence=0` escape hatch, the public-API safety case
  (Codex #25 regression — omitted field still triggers the guard),
  and the negative-value clamp.
- 2 new tests in `test/config.test.ts` covering the default value
  (`0.35`), override, and `[0, 1]` clamping with non-finite inputs.

## [3.2.1] - 2026-05-23

### Fixed — router and reranker received the aggregated context, not the user query

In 3.2.0, the hook handler called `extractQueryFromMessages(event.messages)`
to obtain the user query that drove routing decisions and reranker calls.
Empirical observation in production (Opik trace
`019e565a-806b-...`) showed that on a real CLI turn with a 146-char user
prompt (`"Sender (untrusted metadata)...\n[Sat 2026-05-23 15:40 EDT] Quel
est la version du plugin knowledge ?"`), the `messages[last].content`
slot reached **23 893 chars** — OpenClaw 2026.5.x aggregates the
conversation window plus framing in there for LLM consumption.

Effect: the heuristic router (keyword matching, CLI-trivial regex,
meta-agent regex) ran against ~24 KB of accumulated context instead of
the 50-char user utterance. Matches fired effectively at random and the
router decisions became uncorrelated with the actual question. The
Jina classifier, when active, embedded a 24 KB blob for every turn —
needlessly expensive and noisy.

The SDK exposes the raw user prompt directly via `event.prompt`
(`PluginHookBeforePromptBuildEvent.prompt`, SDK >= 2026.5.0). The fix
reads `event.prompt` first, strips the OpenClaw envelope (sender
metadata + `[Day YYYY-MM-DD HH:MM TZ]` marker) via the new
`stripOpenClawHeaders()` helper, and falls back to the legacy
`extractQueryFromMessages` path only when `event.prompt` is absent.

Two new exported helpers (`extractUserQuery`, `stripOpenClawHeaders`)
cover the extraction logic and are unit-tested with 13 cases including
the exact 24 KB regression scenario.

### Migration

Drop-in patch — no config change required. `update` the plugin and
restart the gateway:

```bash
sudo docker exec openclaw-jerome openclaw plugins update @lacneu/openclaw-knowledge
sudo docker exec openclaw-olivier openclaw plugins update @lacneu/openclaw-knowledge
sudo docker restart openclaw-jerome openclaw-olivier
```

After the restart, `[knowledge.event]` logs should show `queryLength`
in the tens-to-hundreds range on normal CLI turns (down from
~24 000 in 3.2.0).

### Envelope-stripping contract

The OpenClaw envelope produced by `event.prompt` follows this grammar:

```
( <header> "(" ("untrusted"|"metadata") <variant> "):" \n ``` <body> ``` \n+ ){0,8}
( [ <day> YYYY-MM-DD HH:MM[:SS] <tz> ] )?
<user utterance>
( <header> "(" ("untrusted"|"metadata") <variant> "):" <anything>  EOF )?
```

The trailing suffix's body can be a fenced code block OR raw lines
(e.g. `<<<EXTERNAL_UNTRUSTED_CONTENT` / `Source:` markers). We anchor
on the header line only and drop everything after it.

`stripOpenClawHeaders` matches this shape anchored at the start:

- ZERO to EIGHT inbound-context blocks whose header contains any
  `(untrusted …)` sentinel — covers the six SDK-known sentinels
  (`Sender`, `Conversation info`, `Thread starter`, `Replied message`,
  `Forwarded message context`, `Chat history since last reply`) plus
  headroom for future additions.
- An OPTIONAL timestamp marker that can appear EITHER before OR after
  the metadata blocks. Both `block+ ts?` (legacy CLI path) and
  `ts blocks+` (timestamp-first injection path) are accepted because
  production traces show the SDK emits both orderings. CLI turns
  include the marker; webchat / Telegram channels can embed the
  timestamp inside the `Conversation info` JSON instead. When present,
  the TZ suffix is permissive (`[^\]\n]+`) so it accepts named
  abbreviations (`EDT`, `UTC`, …) AND `Intl.DateTimeFormat` offsets
  (`GMT+2`, `GMT+5:30`, `UTC-5`).
- The leading anchor preserves user content that itself contains
  timestamp-shaped substrings (e.g. a pasted log excerpt).
- The hard cap of `MAX_ENVELOPE_BLOCKS + 2` iterations bounds the
  regex engine's worst-case cost on malformed input.

`extractUserQuery` is authoritative on `event.prompt`: when the SDK
supplies it, the result of `stripOpenClawHeaders` is returned as-is,
even when empty. The legacy `extractQueryFromMessages(event.messages)`
fallback is only taken when `event.prompt` is `undefined` (older SDK).
Downstream `MIN_QUERY_LENGTH` drops empty results, so the
present-but-empty case is safe.

### Test coverage

- Total: 223 tests, all green.
- 34 tests in `test/extract-query.test.ts` covering both helpers,
  including the v3.2.0 regression scenario (146-char prompt vs 24 KB
  messages aggregate), the Codex pass #7 regression (empty-stripped
  prompt MUST NOT fall back to the messages aggregate), the Codex
  pass #8 regression (inner timestamp in user content MUST NOT trigger
  stripping), the Codex pass #9 regression (multiple stacked metadata
  blocks before the marker MUST all be stripped), the Codex pass #10
  regression (`(untrusted, for context)` sentinel + GMT/UTC offset TZ
  formats), and the Codex pass #24 regression (timestamp-first envelope
  ordering: `[Sat …] Sender (untrusted metadata): … user query`).

## [3.2.0] - 2026-05-23

### Added — Jina-powered router (`jina.router.*`)

The plugin can now skip retrieval entirely when the user turn is clearly
not a knowledge-base question. Two operational sources of waste are
eliminated:

- **Heartbeats**, **cron**, and **memory** triggers (from
  `PluginHookAgentContext.trigger`) — gated deterministically, zero
  Jina cost, zero ambiguity. In observed traces these accounted for the
  majority of pgvector / LightRAG / Jina rerank calls.
- **Meta-agent questions** ("what is your session id", "combien d'agents
  dans cette instance") that the knowledge base can never answer.
- **CLI test pings** (`isCli && /^test|ping|hello|salut.*$/i`) when the
  sender is the local CLI harness.

Two modes:

- `heuristic` (default) — zero-cost regex + trigger rules only. Safe to
  enable as a first step; never crashes, never consumes Jina tokens.
- `jina-classifier` — same heuristics first, then Jina `/v1/classify`
  for ambiguous queries. Supports both **zero-shot** (built-in labels)
  and **few-shot** (operator-trained `classifierId`). The plugin does
  NOT implement `/v1/train` — training is an out-of-band step.

The router is **fail-open** by contract: any Jina outage falls back to
`ALL` (the pre-3.2.0 behavior) and never blocks the agent.

### Added — Jina-powered pgvector reranker (`jina.pgvectorReranker.*`)

After the cosine-similarity recall stage, results may optionally be
re-ordered by a Jina cross-encoder. This dramatically improves precision
on noisy candidate sets (the 0.36–0.41 cosine scores we observed in
production were below the practical relevance floor).

- Default model: `jina-reranker-v2-base-multilingual` (recommended for
  French content; v3 is English-biased).
- Hard-coded `return_documents: false` for token economy (the plugin
  already owns the source rows; only `(index, score)` is needed back).
- Hard-coded `truncate: true` so over-long chunks get clipped rather
  than failing the whole batch.
- Independent cooldown counter — a Jina rerank outage does NOT trip the
  router cooldown, and vice versa.
- At init, warns if `topK < pgvectorRerankerTopN × 2` (not enough recall
  for the reranker to meaningfully change ordering).

### Added — structured event tracing (`[knowledge.event]`)

Every router decision, source execution, reranker run, and cooldown
transition emits a single-line JSON event through `logger.info`, prefixed
with `[knowledge.event] `. Operators can scrape these lines into Opik,
LangFuse, or any OTLP collector without the plugin needing to depend on
a specific tracing SDK (preserves the single-`pg`-dep promise).

### Added — modular Jina client (`src/jina/`)

A small, dependency-free HTTP client (`client.ts`) used by the classifier
and reranker. Features:

- Bearer-only auth — the API key never appears in the URL or in error
  messages.
- AbortController-based 8 s timeout per request, composable with a
  caller-supplied `AbortSignal`.
- Defensive JSON parsing — CDN HTML 5xx pages don't crash the plugin.
- Typed errors: `JinaAuthError` / `JinaRateLimitError` / `JinaApiError`
  / `JinaNetworkError` (all extending `JinaError`).
- Error bodies truncated to 200 chars in messages, matching the existing
  pattern in `embeddings.ts` / `lightrag.ts`.

### Changed — hook handler now reads `PluginHookAgentContext`

`createBeforePromptBuildHandler` returns a handler with the canonical
SDK signature `(event, ctx?)`. `ctx.trigger` is consumed by the router
gate; other ctx fields are ignored. The change is backward-compatible —
calling the handler with no `ctx` argument keeps the pre-3.2.0 behavior.

### Changed — three independent cooldown counters

The pre-existing 3-errors → 5-min cooldown remains shared between
pgvector and LightRAG (the "global" scope). Router and pgvector reranker
each get their own counter so a Jina outage on one path cannot stop the
other. All three are reset to zero on the first success after expiry.

### Migration

Pre-3.2.0 configs continue to work identically — every new feature
defaults to OFF and requires explicit opt-in via the `jina.*` block.
The `jina` block as a whole is optional; omit it to keep current
behavior.

To enable the router (recommended starting point):

```yaml
plugins:
  openclaw-knowledge:
    config:
      jina:
        apiKey: ${JINA_API_KEY}
        router:
          enabled: true
          mode: heuristic   # safe default, no Jina calls
```

> **Operational note — `isCli` heuristic.** The CLI-trivial skip rule
> fires only when `ctx.messageProvider === "cli"`. The exact value the
> OpenClaw SDK populates depends on the channel that initiated the
> turn. Before enabling the router in production, log `ctx.messageProvider`
> for one CLI turn and verify it matches `"cli"`. If your gateway uses
> a different identifier, the safest path is to leave this branch
> dormant — meta-agent regex and trigger gating already cover the most
> wasteful traffic (heartbeats, "what is your session id?").

To enable the pgvector reranker:

```yaml
      jina:
        apiKey: ${JINA_API_KEY}
        pgvectorReranker:
          enabled: true
          # model: jina-reranker-v2-base-multilingual  (default)
          # topN: 5  (default)
      topK: 20  # recommended ≥ rerankerTopN × 2
```

### Fixed during code review

Eleven pre-release issues flagged across six Codex adversarial review
passes (2026-05-23):

- **Label/Route name mismatch.** The classifier labels used the literal
  `"NO_RETRIEVAL"` while the `Route` type and `isKnownRoute()` only
  accepted `"NONE"`. Effect: every no-retrieval prediction silently fell
  back to `ALL`, defeating the whole point of the router for the most
  important class. Few-shot classifiers trained against `"NONE"` were
  also unreachable. Renamed `ROUTE_NO_RETRIEVAL` → `ROUTE_NONE` with the
  literal value `"NONE"`. Operators training a few-shot classifier must
  use the four canonical names `NONE`, `PGVECTOR_ONLY`, `LIGHTRAG_ONLY`,
  `ALL`. Pinned by a regression test.

- **Exclusive route on single-source deployment dropped retrieval.**
  In a pgvector-only deployment (no LightRAG), a router decision of
  `LIGHTRAG_ONLY` produced zero tasks and a silent context drop, even
  though pgvector was available. Added `projectRouteOnEnabledSources()`
  that falls back from `PGVECTOR_ONLY`/`LIGHTRAG_ONLY` to the available
  source when the target is disabled (and to `NONE` when neither is
  available). `ALL` and `NONE` remain pass-through. The router event
  emitted to the log now reflects the EFFECTIVE (projected) route, not
  the abstract decision. Covered by 7 unit tests + 1 e2e regression
  test.

- **Jina client timeout did not cover the body read.** The internal
  `clearTimeout` ran in a `finally` immediately after `fetch()` returned,
  BEFORE `resp.text()`. If an upstream proxy delivered headers fast but
  stalled the body stream, the response could hang indefinitely (only
  the SDK's outer timeout would eventually catch it — far too long for
  `before_prompt_build`). Refactored `postJson` so the single
  `clearTimeout` + signal-detach happen in an outer `finally` that wraps
  the entire request-AND-body cycle. Added a dedicated regression test
  using a `ReadableStream` body that only completes on abort.

- **README documented the wrong no-retrieval label.** The "Adaptive
  router" section listed `NO_RETRIEVAL` as one of the four routes, but
  the code accepts only `NONE`. Operators following the doc to train a
  few-shot classifier would have produced an unusable classifier.
  Corrected to `NONE` and added an explicit reminder that few-shot
  classifiers MUST be trained against the four canonical names.

- **Privacy: query preview removed from debug logs.** The original
  `emitQueryPreview` logged the first 80 chars of every user query when
  `logger.debug` was active. In Ataraxis-style deployments those queries
  routinely carry PHI / client content / occasionally secrets, so even a
  truncated preview was a leak vector. Replaced by `emitQueryFingerprint`
  which logs a non-reversible SHA-256 prefix (`fp=<12 hex chars>`) and
  the integer length only. Operators still get turn-level correlation
  across the router event, source events, and downstream Opik traces,
  without any portion of the underlying text appearing in logs.
  Regression test asserts that **every word of a sensitive query is
  absent** from the emitted log line.

- **Router heuristic falsely classified business questions as meta.**
  The "status" trigger pattern matched any prompt ending with the word
  "status", so `what is the ACME project status?` was being routed to
  `NONE` (no retrieval). Anchored the relevant patterns with `^`/`$`
  so only whole-prompt pings (`status?`, `system status?`, `are you
  there?`) trigger the meta-skip. Business questions that happen to
  mention the words remain on the retrieval path. Pinned by 4 new
  regression tests.

- **Privacy: Jina error bodies could echo PHI into error logs.**
  `JinaApiError.message` includes the first 200 chars of the upstream
  response body. On `/v1/rerank` failures, that body can echo the user
  query or a document chunk back. The previous
  `logger.error(\`...— \${err.message}\`)` re-published this content in
  plain text. Added `summarizeJinaError()` that returns only the error
  class and HTTP status code (e.g. `JinaApiError(status=503)`), and
  used it everywhere the hook handler logs an error. Body content
  never reaches the log. Covered by 7 new unit tests.

- **Pgvector reranker lost the first turn after cooldown expiry.**
  `maybeResetCooldown` was called AFTER the `rerankerActive` check, so
  the first turn after the 5-min window expired still ran cosine-only,
  even though the operator's log said `resuming`. Moved the reset
  before the check. The behavior is now documented inline and the
  ordering invariant is preserved by source comments — full e2e
  coverage requires a pg.Pool seam that doesn't exist yet.

- **Router cooldown re-enabled retrieval for heartbeats during a Jina
  outage.** `runRouterWithCooldown` used to short-circuit straight to
  `ALL` once the classifier circuit opened, bypassing the zero-cost
  heuristic layer entirely. Result: during a 5-minute Jina outage,
  every heartbeat / cron / meta-question would resume calling
  pgvector + LightRAG — the exact waste the router was designed to
  block. Fixed by DOWNGRADING the router mode to `"heuristic"` during
  cooldown rather than short-circuiting, so heartbeat / trigger /
  meta-regex / CLI rules still apply. Pinned by an end-to-end
  regression test that: trips 3 classifier errors, then sends a
  heartbeat turn and asserts ZERO fetch calls (no Gemini embed, no
  LightRAG, no Jina). The error counter is also no longer reset by
  successful heuristic-only turns during cooldown — that would have
  prematurely declared the classifier healthy.

- **Privacy: query fingerprint hash was dictionary-recoverable on
  short prompts.** `emitQueryFingerprint` emitted the first 12 hex
  chars of `SHA-256(query)` as a debug-only "non-reversible"
  correlation key. On low-entropy prompts (the hook accepts queries as
  short as 3 chars), the hash is brute-forceable offline against a
  dictionary of likely prompts — so the "privacy invariant" was leaky
  in exactly the deployments where it mattered most. Removed the hash
  entirely. Replaced by `emitTurnMetadata(logger, ctx.runId, query.length)`
  which emits the SDK's non-query-derived `runId` and a length count
  only. Pinned by a regression test that asserts no query word AND no
  long hex token appears in the debug line. Operators who want
  cross-turn content correlation must instrument at the SDK layer with
  their own keyed scheme (HMAC + deployment secret); the plugin will
  not do it.

- **Telemetry: `rawCount` was post-rerank, hiding recall vs pruning.**
  When the pgvector reranker was active, `PgvectorEvent.rawCount`
  reflected the post-rerank truncated size (`topN`), not the number of
  candidates pgvector actually returned. Operators relying on the
  event to monitor recall would see the wrong value. Fixed by carrying
  the pre-rerank count as a dedicated `rawCount: number` field on the
  internal `PgvectorSourceResult`, captured BEFORE `rerankPgvectorResults`
  runs. `rerankedCount` continues to reflect the post-truncation final
  size, so operators can compute pruning = `rawCount − rerankedCount`.

### Test coverage

- 56 pre-existing tests preserved (no behavioral regression on legacy
  paths).
- 133 new tests covering: Jina client error mapping (incl. body-stall
  abort regression), `summarizeJinaError` privacy contract, classifier
  defensive parsing across 4 known response shapes, reranker defensive
  parsing, router heuristics across triggers / meta-regex / CLI / keyword
  fast-paths (incl. business-status false-positive regression), router
  orchestration in all fail-open scenarios incl. heuristic preservation
  during classifier cooldown, route projection onto enabled sources,
  pgvector reranker integration, turn-metadata tracing via SDK runId
  (regression-pinned: no query content, no hash, in logs).
- Total: 189 tests, all green.

### TODO — full migration to `kind: "context-engine"` (deferred)

The OpenClaw doctor classifies the current `before_prompt_build`-only
mode as `INFO — supported compatibility path, but has not migrated
to explicit capability registration yet`. A proper migration would
declare `kind: "context-engine"` in the manifest and use
`api.registerContextEngine("openclaw-knowledge", (ctx) => ({ info,
ingest, assemble, compact, ...optional }))` instead of the
`before_prompt_build` hook.

That migration is **deferred** until:

1. A reference plugin with `kind: "context-engine"` becomes
   available in the OpenClaw upstream `extensions/` folder (none as
   of 2026-05-03 — only the in-process `legacy` engine exists).
2. The `concepts/context-engine` page documents a complete migration
   guide for hook-only plugins.

Until then, the hook approach is officially supported and works. We
take this 3.1.1 release to align activation/compat with 2026.5.0
without disturbing the working RAG path.

## [3.1.2] - 2026-05-03

### Added — `activation.onStartup: true`

Per the OpenClaw 2026.5.x manifest spec, plugins should declare an
explicit activation policy. `onStartup: true` ensures the plugin is
loaded at gateway boot so the `before_prompt_build` hook is wired
in time for the first turn after restart.

### Changed — compat aligned to 2026.5.0

- `package.json#openclaw.compat`:
  `pluginApi: ">=2026.3.7"` → `">=2026.5.0"`,
  `minGatewayVersion: "2026.3.7"` → `"2026.5.0"`.
- `peerDependencies.openclaw` and `devDependencies.openclaw`:
  `">=2026.3.7"` → `">=2026.5.0"`.

### Migration

For instance owners on `@lacneu/openclaw-knowledge@3.1.0` or `3.1.1`:

1. `openclaw plugins install @lacneu/openclaw-knowledge@3.1.2 --force`
2. Restart the gateway container.
3. Verify in the boot log:
   `openclaw-knowledge: ready — sources: pgvector + LightRAG`.
4. Verify with `openclaw plugins doctor` — the INFO note about
   "hook-only" remains (expected; full `kind: "context-engine"`
   migration is deferred).

### Notes

- No code change in `src/`. No config schema change.
- 5/5 tests still pass.
- Operators on OpenClaw < 2026.5.0 must keep
  `@lacneu/openclaw-knowledge@3.1.0`.

## [3.1.0] - 2026-04-10

### Changed
- **Distribution migrated to npm as `@lacneu/openclaw-knowledge`.** The plugin
  is now published to the public npm registry under the `lacneu` organization
  and installs via the official OpenClaw CLI:
  ```bash
  openclaw plugins install @lacneu/openclaw-knowledge
  openclaw plugins update  @lacneu/openclaw-knowledge
  ```
  OpenClaw tracks the install under `plugins.installs`, so `openclaw plugins update`
  works out of the box — no custom deployment script required.
- `package.json` renamed to the scoped package `@lacneu/openclaw-knowledge`
  and now declares `publishConfig.access: "public"`, a narrow `files` allowlist
  (dist, manifest, README, CHANGELOG, LICENSE), `repository`, `homepage`, `bugs`
  and `keywords` metadata for discoverability on npmjs.com.
- GitHub Actions release workflow now runs `npm publish --access public` via
  **npm Trusted Publishing (OIDC)** — no `NPM_TOKEN` secret needed. The workflow
  requests an OIDC token from GitHub, exchanges it for a short-lived npm
  credential scoped to this repo + workflow, and ships a provenance statement
  with every release (automatic with Trusted Publishing, `--provenance` flag no
  longer needed). No bundled tarball artifact — the GitHub Release is still
  created for changelog visibility but carries no files.
- **Full migration to TypeScript + the official OpenClaw plugin SDK.** The plugin now
  uses `definePluginEntry` from `openclaw/plugin-sdk/plugin-entry` as the canonical
  entry point, replacing the bare `{ id, name, register }` object export.
- Source code is split into focused modules under `src/`:
  `index.ts` (entry + hook wiring), `config.ts` (resolveEnv + defaults),
  `embeddings.ts` (Gemini client), `pgvector.ts` (PostgreSQL search + formatter),
  `lightrag.ts` (LightRAG client + truncation), `types.ts` (shared interfaces).
- Tests migrated to TypeScript under `test/*.test.ts` using `node:test`.
  Coverage trimmed to 56 tests after removing legacy-shape test cases.
- Business logic is **unchanged**: same hook (`before_prompt_build`), same output
  format (`### Document Search Results` + `### Knowledge Graph Context`), same
  parallel execution via `Promise.allSettled`, same cooldown (3 errors → 5 min),
  same Gemini native `embedContent` endpoint, same `halfvec(3072)` SQL cast.
- Current plugin configurations (Olivier and Jerome instances) continue to work
  without any changes — all config keys and defaults are preserved. The breaking
  changes below are limited to internal types and legacy input shapes that were
  defensive cruft, not fields used by active deployments.

### Added
- `tsconfig.json` with strict mode (`noImplicitAny`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`).
- `tsconfig.test.json` and `tsconfig.test-build.json` for typecheck and test compilation.
- `npm run build`, `npm run typecheck`, `npm run clean` scripts.
- `@types/node`, `@types/pg`, `typescript`, and `openclaw` (for SDK types) as
  `devDependencies`.
- Release workflow now runs `npm run typecheck`, `npm run build`, then prunes to
  production dependencies before bundling. The release tarball ships the compiled
  `dist/` directory rather than raw source.
- CI workflow runs typecheck, tests, and build on Node.js 22 and 24.

### Removed (BREAKING)
- `index.js` and `index.test.js` at the repository root (replaced by `src/` and `test/`).
- Legacy message shapes in `extractQueryFromMessages`: the `sender` field (alias
  for `role`), the `"human"` role alias, and the `{text: "..."}` fallback form
  are no longer recognized. Only the canonical `{role, content}` shape is accepted,
  where `content` is a `string` or an array of `{type, text}` parts.
- Legacy LightRAG response shapes in `queryLightRAG`: plain string responses and
  `{context: ...}` payloads are no longer normalized. Only the current
  `{response: string}` shape is supported (LightRAG 1.4.x+).
- `PromptMessage.sender`, `PromptMessage.text`, and the `[key: string]: unknown`
  index signatures on `PromptMessage` and `PromptContentPart` are removed from
  the exported types. Strict structural typing only.
- `truncateLightRAG(text: string | null | undefined, ...)` tightened to
  `truncateLightRAG(text: string, ...)`. Callers must pre-check for non-empty.
- `resolveConfig(raw: KnowledgePluginConfig | null | undefined)` tightened to
  `resolveConfig(cfg?: KnowledgePluginConfig)`. Pass `{}` or no argument instead
  of `null` / `undefined`.
- `PgvectorRow.score` type tightened from `string | number` to `string` (matches
  actual `pg` driver behaviour for numeric columns).

### Previous [Unreleased] entries (now folded into this TS migration)
- `package.json` now declares `openclaw.compat.pluginApi` and `openclaw.compat.minGatewayVersion`
  so OpenClaw can validate compatibility before loading the plugin.
- Full `uiHints` coverage in `openclaw.plugin.json` for every config field (labels, placeholders,
  `sensitive: true` on secrets, `advanced: true` on tuning knobs).
- JSON Schema constraints in `configSchema`: `default`, `minimum`/`maximum` on numeric fields,
  `enum` on `lightragQueryMode`, explicit `default` on `enabled`, `topK`, `scoreThreshold`,
  `maxInjectChars`, `lightragMaxChars`, `lightragQueryMode` and `collections`.
- Manifest `description` updated to explicitly mention the `before_prompt_build` hook.
- `peerDependencies.openclaw` bumped to `>=2026.3.7` to match the hook requirement already
  stated in the README.

## [3.0.4] - 2026-04-10

### Fixed
- Release tarball now bundles `node_modules` with the `pg` dependency, eliminating
  the need for `npm install` at deployment time. Previously, runtime `npm install`
  would silently fail on Docker installations with tmpfs cache conflicts, leaving
  the plugin unable to load (`Cannot find module 'pg'`).

### Changed
- `update-knowledge-plugin.sh` simplified: no longer runs `npm install` on target
  containers, only verifies that bundled dependencies are present.

## [1.2.0] - 2026-03-30

### Changed
- Reverted hook from `before_prompt_build` back to `before_agent_start` for broader compatibility.
- Changed context injection from `appendSystemContext` to `prependContext` with `<relevant-documents>` tagging.
- Added logic to prevent memory pollution by `autoCapture`.

### Fixed
- Release workflow now stamps version from tag into `package.json` and `openclaw.plugin.json` before building artifact.
- Improved logging: removed noisy event keys log, added query length and preview logging.

## [1.1.2] - 2026-03-30

### Fixed
- Enhanced logging in `before_prompt_build` hook: capture event keys and improve query handling logic.

## [1.1.1] - 2026-03-30

### Changed
- Stabilized hook naming: renamed from `before_agent_start` to `before_prompt_build`.
- Updated test cases to reflect new hook names.
- Streamlined query handling and improved context injection logic.

## [1.1.0] - 2026-03-30

### Changed
- Switched hook from `before_agent_start` to `before_prompt_build`.
- Changed injection mechanism from `prependContext` to `appendSystemContext` for system prompt handling.
- Expanded README with installation and update guidance.

## [1.0.0] - 2026-03-30

### Added
- Multi-collection Qdrant vector search via `before_agent_start` hook.
- Query embedding using Gemini Embedding 2 Preview (3072 dimensions, cross-modal compatible).
- Parallel search across multiple Qdrant collections.
- Results sorted by similarity score, injected as `<relevant-documents>` block via `prependContext`.
- Environment variable substitution in config values (`${VAR_NAME}` syntax).
- Configurable score threshold, top-K, max injection size, and per-instance collection list.
- Fail-safe error handling: errors never block the agent.
- Cooldown mechanism: pauses 5 minutes after 3 consecutive failures.
- Unit tests (26 tests) using Node.js built-in test runner (`node:test`).
- CI workflow: tests on Node.js 18, 20, and 22.
- Release workflow: creates GitHub Release with tarball on tag push.
- Architecture, lifecycle, and sequence diagrams in `schemas/`.

[Unreleased]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v3.2.1...HEAD
[3.2.1]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v3.2.0...v3.2.1
[3.2.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v3.1.2...v3.2.0
[3.1.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.2.0...v3.1.0
[1.2.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/releases/tag/v1.0.0
