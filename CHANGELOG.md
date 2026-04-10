# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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

[Unreleased]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/OlivierNeu/openclaw-knowledge-plugin/releases/tag/v1.0.0
