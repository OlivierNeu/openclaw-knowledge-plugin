# Spec — v3.2.5 LightRAG discovery mode

**Status:** Spec only — implementation deferred to ~2026-06-01..2026-06-08.

## Summary

Introduce `lightragMode: "full" | "discovery"` to the plugin
configuration. In `discovery` mode, the LightRAG-injected prompt block
becomes a ranked **list of source file paths** instead of the full
chunk-and-entity context. The downstream agent then fetches verbatim
content via a separate skill call (`gworkspace-search`,
`obsidian-read`, …).

See `openclaw-notes/docs/design-lightrag-discovery-verbatim-split.md`
for the architectural rationale and migration plan.

## Config surface

### `openclaw.plugin.json` (configSchema additions)

```jsonc
"lightragMode": {
  "type": "string",
  "enum": ["full", "discovery"],
  "default": "full",
  "description": "full (default): inject the full LightRAG context (chunks + entities). discovery: inject only a ranked list of source file paths — the downstream agent must fetch verbatim via a skill (`gworkspace-search`, `obsidian-read`). Drops Jina rerank tokens to ~zero when paired with LightRAG `RERANK_BY_DEFAULT=False`."
},
"lightragDiscoveryMaxSources": {
  "type": "number",
  "minimum": 1,
  "maximum": 50,
  "default": 10,
  "description": "When lightragMode=discovery, max file paths injected in the Relevant Sources block. Cosine-ranked truncation."
}
```

### `uiHints` additions

```jsonc
"lightragMode": {
  "label": "LightRAG injection mode",
  "advanced": true,
  "help": "discovery mode drops Jina rerank to ~zero but requires a downstream verbatim skill. Default: full."
},
"lightragDiscoveryMaxSources": {
  "label": "Discovery — max sources",
  "advanced": true,
  "help": "Cap on file paths injected in discovery mode. Default 10."
}
```

## Type changes

### `src/types.ts`

```ts
export interface KnowledgePluginConfig {
  // ... existing fields ...
  /** @since 3.2.5 */
  lightragMode?: "full" | "discovery";
  /** @since 3.2.5 */
  lightragDiscoveryMaxSources?: number;
}

export interface ResolvedKnowledgeConfig {
  // ... existing fields ...
  lightragMode: "full" | "discovery";
  lightragDiscoveryMaxSources: number;
}
```

### `src/config.ts`

```ts
const DEFAULT_LIGHTRAG_MODE = "full" as const;
const DEFAULT_LIGHTRAG_DISCOVERY_MAX_SOURCES = 10;

// In resolveConfig():
return {
  // ...
  lightragMode: cfg.lightragMode === "discovery" ? "discovery" : DEFAULT_LIGHTRAG_MODE,
  lightragDiscoveryMaxSources: clampNonNegInt(
    cfg.lightragDiscoveryMaxSources ?? DEFAULT_LIGHTRAG_DISCOVERY_MAX_SOURCES,
  ),
};
```

## Behavior changes

### `src/index.ts:renderSection` (lightrag branch)

```ts
if (result.source === "lightrag") {
  const formatted = formatLightRAGResults(result.data, config.lightragMaxChars);
  const truncatedLen = formatted?.truncated.length ?? 0;
  const originalLen = formatted?.originalLength ?? result.data.length;
  emitEvent(logger, {
    type: "lightrag",
    mode: config.lightragQueryMode,
    contextChars: originalLen,
    truncatedChars: truncatedLen,
    durationMs: result.durationMs,
    sparse: truncatedLen < LIGHTRAG_SPARSE_THRESHOLD_CHARS,
    // NEW: which injection mode was active
    injectionMode: config.lightragMode,
  });

  if (config.lightragMode === "discovery") {
    const sources = extractSourcesFromLightRAGResponse(
      result.data,
      config.lightragDiscoveryMaxSources,
    );
    if (sources.length === 0) return null;
    return renderDiscoveryBlock(sources);
  }

  if (!formatted) {
    logger.info(`openclaw-knowledge: LightRAG — empty response (${originalLen} chars)`);
    return null;
  }
  // existing full-mode behavior
  logger.info(`openclaw-knowledge: LightRAG — ${formatted.truncated.length}/...`);
  return "### Knowledge Graph Context (LightRAG)\n" + formatted.truncated;
}
```

### New helpers

`extractSourcesFromLightRAGResponse(rawResponse, maxSources)`:
- Parse the LightRAG response payload to find `references: [{reference_id, file_path}]`.
- Deduplicate by `file_path`.
- Cap to `maxSources`.
- Return `{file_path, topics?, score?}[]` where `topics` is an optional
  ranked entity list extracted from the response body.

`renderDiscoveryBlock(sources)`:
```ts
function renderDiscoveryBlock(sources: DiscoverySource[]): string {
  const lines: string[] = [];
  lines.push("### Relevant Sources (LightRAG discovery)");
  lines.push("");
  lines.push(
    "The following documents are likely relevant to the user's question.",
    "Use the `gworkspace-search` or `obsidian-read` skill to retrieve",
    "their verbatim content BEFORE composing the answer. Always cite the",
    "source filename and the section title in your final response.",
  );
  lines.push("");
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const topics = src.topics?.length ? `  topics: ${src.topics.slice(0, 5).join(", ")}` : "";
    lines.push(`${i + 1}. \`${src.file_path}\`${topics}`);
  }
  return lines.join("\n");
}
```

## Event shape change

`LightRAGEvent.injectionMode: "full" | "discovery"` (new optional field).
Useful for dashboards to distinguish the two paths.

## Tests required

| Test | Description |
|---|---|
| `lightragMode=full` (default) | Existing behavior preserved, no regression. |
| `lightragMode=discovery` happy path | LightRAG returns N references, plugin injects a ranked list with topics. |
| `lightragMode=discovery` empty | LightRAG returns no references, plugin returns null (no injection). |
| `lightragDiscoveryMaxSources=3` | Plugin truncates to 3 even if LightRAG returns 10. |
| `discovery` event `injectionMode` | Emitted with correct value. |
| Negative — `lightragMode=discovery` with malformed LightRAG payload | Plugin returns null + logs warning, never crashes. |

## Backward compatibility

- Default `lightragMode=full` → existing deployments behave identically.
- Schema change is additive (optional fields).
- All existing tests must continue to pass without modification.

## Out of scope for v3.2.5

- **Calling the verbatim skill from the plugin.** The plugin only
  surfaces the list; the agent does the work via the OpenClaw skill
  system. (Future v3.3.0 could integrate if the pattern proves clunky.)
- **Re-implementing the LightRAG `references` parser.** v3.2.5 assumes
  LightRAG ≥ 1.4.5 emits the references block consistently. If
  LightRAG changes shape, plugin gets a follow-up.

## Implementation checklist (for the future session)

1. [ ] Update `KnowledgePluginConfig` + `ResolvedKnowledgeConfig`
2. [ ] Update `resolveConfig` defaults + clamping
3. [ ] Implement `extractSourcesFromLightRAGResponse`
4. [ ] Implement `renderDiscoveryBlock`
5. [ ] Update `renderSection` lightrag branch
6. [ ] Update `LightRAGEvent` with `injectionMode` field
7. [ ] Update `openclaw.plugin.json` configSchema + uiHints
8. [ ] Bump version to 3.2.5
9. [ ] Tests (see table above)
10. [ ] CHANGELOG entry
11. [ ] Run `npm run build && npm test`
12. [ ] `/codex:review` round
