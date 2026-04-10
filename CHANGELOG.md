# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `package.json` now declares `openclaw.compat.pluginApi` and `openclaw.compat.minGatewayVersion`
  so OpenClaw can validate compatibility before loading the plugin.
- Full `uiHints` coverage in `openclaw.plugin.json` for every config field (labels, placeholders,
  `sensitive: true` on secrets, `advanced: true` on tuning knobs).
- JSON Schema constraints in `configSchema`: `default`, `minimum`/`maximum` on numeric fields,
  `enum` on `lightragQueryMode`, explicit `default` on `enabled`, `topK`, `scoreThreshold`,
  `maxInjectChars`, `lightragMaxChars`, `lightragQueryMode` and `collections`.

### Changed
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
