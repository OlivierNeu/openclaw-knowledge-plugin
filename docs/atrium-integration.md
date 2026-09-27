# Atrium integration contract — openclaw-knowledge ≥ 4.0.0

This document is the **normative contract** a client (Atrium, or any Gateway
operator client) implements to display and control knowledge retrieval per agent,
per conversation and per prompt. It targets OpenClaw **2026.9.x** (verified against
the v2026.9.6 sources; file references below are relative to the OpenClaw repo).

- Plugin id: **`openclaw-knowledge`**
- Session-extension namespace: **`policy`**
- Provenance stream (unchanged since 3.2.x): `openclaw-knowledge.provenance`

---

## 1. Model

```
effective policy for one human turn =
    one-shot           (per prompt, consumed by the next human turn)
  > session override   (per conversation)
  > agent default      (plugin config `agents.<agentId>`)
  > global default     (plugin config `defaults`, else: auto + every enabled source)
```

A policy is:

| Field | Values | Meaning |
|-------|--------|---------|
| `injection` | `auto` \| `hybrid` \| `tool` \| `off` | `auto`: inject relevant documents every turn. `hybrid`: inject only when the router is confident the turn is a knowledge-base question, otherwise rely on the tool. `tool`: never inject; the model calls `knowledge_search`. `off`: nothing, and the tool refuses. |
| `sources` | array of source ids | Which named sources are searched. |
| `lightragQueryMode` | `naive` \| `local` \| `global` \| `hybrid` \| `mix` | Optional LightRAG depth override. `naive` is fast (no LLM step); the others start with an LLM keyword extraction and are slower. |

**Security invariant.** Every agent has an allowlist (`allowedSources`, defaulting
to its default `sources`). Whatever a client stores, the plugin clamps the
selection to that allowlist **on every read**; disallowed ids are dropped (and a
level whose whole selection is disallowed is ignored). The write path described in
§4 additionally **rejects** them. A client can never make an agent search a source
the operator did not grant it. Source URLs, API keys and pgvector collection names
are never exposed through this contract.

**What consumes a one-shot.** Only a turn that passes the non-human filters: a
heartbeat, cron, memory or `manual` run, a sub-agent session, inter-session /
internal-system input never consumes it. An acknowledgement ("merci", "ok") consumes
it only when the one-shot forces retrieval (`force`, default `true`). A retry or
prompt rebuild of the same run reuses the consumed choice. An unconsumed one-shot
expires after `controlPlane.oneShotTtlMs` (default 10 min, counted from the write).

**`force`.** A one-shot with `force: true` (default) bypasses the acknowledgement
filter and the router for its turn(s): the user explicitly asked for a knowledge
search, so the selected sources are always queried (`reason: "policy_forced"`).

---

## 2. Scopes and surfaces

| Operation | Gateway method | Required scope | Session authorization |
|-----------|----------------|----------------|-----------------------|
| List sources visible to an agent | `knowledge.sources` | `operator.read` | none (agent-level data) |
| Read the effective policy of a session | `knowledge.policy.get` | `operator.read` | none — prefer `policy.get` below for per-person sessions |
| Read the effective policy (session-authorized) | `plugins.sessionAction` → `policy.get` | `operator.read` | Gateway authorizes the `sessionKey` target |
| **Set** a session override / one-shot | `plugins.sessionAction` → `policy.set` | `operator.write` | Gateway authorizes the `sessionKey` target |
| Remove the session override | `plugins.sessionAction` → `policy.reset` | `operator.write` | Gateway authorizes the `sessionKey` target |
| Raw write (bypasses plugin validation) | `sessions.pluginPatch` | **`operator.admin`** | Gateway authorizes the `key` target |
| Passive read with session rows | `sessions.list` / session events → `pluginExtensions[]` | as for the row | — |

Sources: plugin RPC scopes are declared at registration (`registerGatewayMethod(name,
handler, { scope })`, `src/plugins/plugin-api.types.ts:240-247`); the `knowledge.*`
prefix is not a reserved admin namespace (`src/shared/gateway-method-policy.ts:2-7`).
`plugins.sessionAction` enforces the action's `requiredScopes` and validates the
payload against the action's JSON schema (`src/gateway/server-methods/plugin-host-hooks.ts:110-300`)
and is a session-targeted method (`src/gateway/session-method-policy.ts:18`).
`sessions.pluginPatch` requires `operator.admin` (`src/gateway/server-methods/sessions-mutations.ts:426-512`).
`operator.write` implies `operator.read` (`src/shared/operator-scope-compat.ts:10-28`).

**Recommendation for Atrium:** person sockets (capped below admin) use the session
actions for writes; never depend on `sessions.pluginPatch` from a person socket.

---

## 3. Read surfaces

### 3.1 `knowledge.sources`

Params:

```json
{ "type": "object", "properties": { "agentId": { "type": "string" } }, "additionalProperties": true }
```

Result (`agentId` omitted → the global default policy):

```json
{
  "type": "object",
  "required": ["agentId", "configured", "injection", "defaultSources", "overridesAllowed", "injectionTarget", "sources"],
  "properties": {
    "agentId": { "type": ["string", "null"] },
    "configured": { "type": "boolean", "description": "true when the agent has its own entry in config.agents" },
    "injection": { "enum": ["auto", "tool", "hybrid", "off"] },
    "defaultSources": { "type": "array", "items": { "type": "string" } },
    "overridesAllowed": { "type": "boolean" },
    "injectionTarget": { "enum": ["prependContext", "appendContext", "appendSystemContext"] },
    "sources": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "type", "label", "description", "default"],
        "properties": {
          "id": { "type": "string" },
          "type": { "enum": ["lightrag", "pgvector"] },
          "label": { "type": "string" },
          "description": { "type": "string" },
          "default": { "type": "boolean", "description": "part of the agent's default selection" }
        }
      }
    }
  }
}
```

`sources` lists exactly the sources the agent **may select** (its allowlist), so the
UI never offers an unusable choice.

### 3.2 Policy snapshot (`knowledge.policy.get` and every `policy.*` session action)

Params for `knowledge.policy.get`: `{ "sessionKey": string (required), "agentId"?: string }`
(the agent defaults to the one embedded in `agent:<id>:...`). Reading never consumes
a one-shot. Error: `INVALID_REQUEST` "sessionKey is required".

`PolicySnapshot`:

```json
{
  "type": "object",
  "properties": {
    "agentId": { "type": ["string", "null"] },
    "injection": { "enum": ["auto", "tool", "hybrid", "off"] },
    "sources": { "type": "array", "description": "same shape as knowledge.sources[].sources" },
    "effectiveSources": { "type": "array", "items": { "type": "string" }, "description": "sources a normal turn would search now (one-shot NOT applied)" },
    "lightragQueryMode": { "enum": ["naive", "local", "global", "hybrid", "mix"] },
    "origin": {
      "type": "object",
      "properties": {
        "injection": { "enum": ["session", "agent", "default"] },
        "sources": { "enum": ["session", "agent", "default"] }
      }
    },
    "allowedSources": { "type": "array", "items": { "type": "string" } },
    "overridesAllowed": { "type": "boolean" },
    "injectionTarget": { "type": "string" },
    "session": { "$ref": "#/definitions/SessionPolicyProjection" }
  }
}
```

`session` is the projected session state (§3.3). A pending one-shot is visible in
`session.oneShot`.

### 3.3 Session rows (`pluginExtensions`)

Non-lightweight Gateway session rows carry
`pluginExtensions: Array<{ pluginId, namespace, value }>`
(`src/gateway/session-utils-row.ts:195-196,595`). This plugin's entry is
`{ "pluginId": "openclaw-knowledge", "namespace": "policy", "value": SessionPolicyProjection }`:

```json
{
  "definitions": {
    "SessionPolicyProjection": {
      "type": "object",
      "properties": {
        "v": { "const": 1 },
        "injection": { "enum": ["auto", "tool", "hybrid", "off"] },
        "sources": { "type": "array", "items": { "type": "string" } },
        "lightragQueryMode": { "enum": ["naive", "local", "global", "hybrid", "mix"] },
        "oneShot": {
          "type": "object",
          "properties": {
            "injection": { "enum": ["auto", "tool", "hybrid", "off"] },
            "sources": { "type": "array", "items": { "type": "string" } },
            "lightragQueryMode": { "enum": ["naive", "local", "global", "hybrid", "mix"] },
            "expiresAfterTurns": { "type": "integer", "minimum": 1, "maximum": 20 },
            "force": { "type": "boolean" },
            "setAt": { "type": "number", "description": "epoch ms" }
          }
        },
        "updatedAt": { "type": "number" },
        "updatedBy": { "type": "string", "description": "session-action | command | ..." }
      }
    }
  }
}
```

The entry is absent when the session has no override. The projection is the
**stored** value (sanitized), not the effective policy — use a snapshot (§3.2) to
display what will actually happen.

---

## 4. Write surface — `plugins.sessionAction`

Request params (`packages/gateway-protocol/src/schema/plugins.ts:159-165`):

```json
{
  "pluginId": "openclaw-knowledge",
  "actionId": "policy.set",
  "sessionKey": "agent:jerome:atrium:conv-123",
  "agentId": "jerome",
  "payload": { }
}
```

`agentId` is optional (the Gateway resolves the session's owner agent and passes it
to the plugin). Responses:

- success: `{ "ok": true, "result": PolicySnapshot }`
- plugin-level refusal (RPC succeeds): `{ "ok": false, "error": string, "code": PluginErrorCode }`
- transport errors: see §5.

### 4.1 `policy.set` payload

Validated by the Gateway against this schema, then strictly by the plugin:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "injection": { "enum": ["auto", "tool", "hybrid", "off", null] },
    "sources": { "oneOf": [ { "type": "null" }, { "type": "array", "minItems": 1, "maxItems": 16, "items": { "type": "string" } } ] },
    "lightragQueryMode": { "enum": ["naive", "local", "global", "hybrid", "mix", null] },
    "oneShot": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "injection": { "enum": ["auto", "tool", "hybrid", "off"] },
            "sources": { "type": "array", "minItems": 1, "maxItems": 16, "items": { "type": "string" } },
            "lightragQueryMode": { "enum": ["naive", "local", "global", "hybrid", "mix"] },
            "expiresAfterTurns": { "type": "integer", "minimum": 1, "maximum": 20 },
            "force": { "type": "boolean" }
          }
        }
      ]
    },
    "reset": { "type": "boolean" }
  }
}
```

Semantics: a PATCH. Omitted fields are kept, `null` clears a field, `reset: true`
drops the whole override first (other fields in the same payload then apply).
`oneShot` needs at least one of `injection` / `sources` / `lightragQueryMode`; the
plugin stamps `setAt` itself. Writing any field clears the internal replay guard and
purges this session's cached retrieval results.

### 4.2 `policy.reset`

No payload. Removes the override (and any pending one-shot).

### 4.3 `policy.get`

No payload, `operator.read`. Same result as `knowledge.policy.get`, but the Gateway
authorizes the session target first — prefer it on per-person sockets.

---

## 5. Error codes

| Layer | Code | When |
|-------|------|------|
| Transport | `INVALID_REQUEST` | Params / payload do not match the schema (`plugin session action payload does not match schema: …`), `unknown method: knowledge.*` (plugin not installed / < 4.0), missing `sessionKey` on `knowledge.policy.get` |
| Transport | `FORBIDDEN` | `missing scope: operator.write` (or `.read`) — `packages/gateway-protocol/src/schema/error-codes.ts:163-169` |
| Transport | `UNAVAILABLE` | `unknown plugin session action: openclaw-knowledge/…` (plugin disabled / not loaded) or the handler threw |
| Plugin (`ok:false`) | `invalid_payload` | Semantic validation failure (e.g. empty one-shot, missing `sessionKey`, host without session storage) |
| Plugin | `unknown_source` | A source id that is not configured (`details.sourceId`) |
| Plugin | `source_not_allowed` | A configured source outside the agent's allowlist |
| Plugin | `overrides_disabled` | `controlPlane.sessionOverrides=false` or `agents.<id>.allowSessionOverrides=false` |
| Plugin | `write_failed` | The session store rejected the write (unknown session key, storage error) |

Feature detection: call `knowledge.sources` once per connection; `unknown method`
means the plugin is absent or older than 4.0 — hide the controls.

---

## 6. Raw path — `sessions.pluginPatch` (admin only)

For admin/system sockets only (`src/gateway/server-methods/sessions-mutations.ts:426-512`):

```json
{
  "key": "agent:jerome:atrium:conv-123",
  "pluginId": "openclaw-knowledge",
  "namespace": "policy",
  "value": { "injection": "tool", "sources": ["graph"], "oneShot": { "sources": ["docs"], "setAt": 1790000000000 } }
}
```

or `{ "key": "...", "pluginId": "openclaw-knowledge", "namespace": "policy", "unset": true }`.

The value **replaces** the whole namespace and is stored **without plugin
validation** (the Gateway only checks JSON compatibility); the plugin sanitizes and
clamps it at read time. A one-shot **must** carry `setAt` (epoch ms): an undated
one-shot has no provable age and is ignored (then cleared) by the next human turn. This path emits `sessions.changed` with reason
`plugin-patch`; the session-action path does not broadcast — use its returned
snapshot.

---

## 7. Examples

### 7.1 Show the per-agent default

```json
→ { "method": "knowledge.sources", "params": { "agentId": "jerome" } }
← { "agentId": "jerome", "configured": true, "injection": "auto",
    "defaultSources": ["graph", "docs"], "overridesAllowed": true,
    "injectionTarget": "prependContext",
    "sources": [
      { "id": "graph", "type": "lightrag", "label": "Graphe de connaissances", "description": "…", "default": true },
      { "id": "docs",  "type": "pgvector", "label": "Documents", "description": "…", "default": true } ] }
```

Render one toggle per `sources[]` entry (checked when `default`), plus the injection
mode. Disable the controls when `overridesAllowed` is false.

### 7.2 Per-conversation toggle

```json
→ { "method": "plugins.sessionAction", "params": {
      "pluginId": "openclaw-knowledge", "actionId": "policy.set",
      "sessionKey": "agent:jerome:atrium:conv-123",
      "payload": { "injection": "hybrid", "sources": ["docs"] } } }
← { "ok": true, "result": { "agentId": "jerome", "injection": "hybrid",
      "effectiveSources": ["docs"], "origin": { "injection": "session", "sources": "session" }, … } }
```

Back to the agent default: `actionId: "policy.reset"` (or `payload: { "sources": null }`
to reset only the sources).

### 7.3 Per-prompt one-shot (e.g. "search the knowledge graph for this message")

Sequence — the write MUST be acknowledged before the message is sent:

```json
1 → { "method": "plugins.sessionAction", "params": {
        "pluginId": "openclaw-knowledge", "actionId": "policy.set",
        "sessionKey": "agent:jerome:atrium:conv-123",
        "payload": { "oneShot": { "injection": "auto", "sources": ["graph"], "lightragQueryMode": "hybrid" } } } }
1 ← { "ok": true, "result": { …, "session": { "v": 1, "oneShot": { "injection": "auto", "sources": ["graph"],
        "lightragQueryMode": "hybrid", "setAt": 1790000000000 } } } }
2 → { "method": "chat.send", "params": { "sessionKey": "agent:jerome:atrium:conv-123", "message": "…" } }
```

The next human turn of that session uses exactly this choice (router bypassed,
`timing.policy.origin = {injection:"oneShot", sources:"oneShot"}`), then the session
falls back to its override / agent default. To cancel before sending:
`payload: { "oneShot": null }`. If the send fails, the one-shot stays pending until
consumed or expired (10 min) — clear it explicitly if the user abandons the prompt.

### 7.4 List sources for a picker

Use §7.1; for an existing conversation prefer `policy.get`, whose `sources` is the
allowlist and `effectiveSources` the current selection.

---

## 8. Chat users (Telegram / WhatsApp)

The `/knowledge` command writes the same session state (never reaches the LLM):
`/knowledge` (status), `/knowledge auto|hybrid|tool|off`, `/knowledge use <id>[,<id>]`
(`use all` = agent default), `/knowledge once <id>[,<id>]` (next message only),
`/knowledge reset`. Atrium sees those changes through §3.

---

## 9. Observability hooks for the UI

- `timing` events (`[knowledge.event]` log lines) carry the resolved policy and
  `origin` per turn.
- Provenance reports (`openclaw-knowledge.provenance`) now report where the block
  landed: `injected.position` ∈ `user_prepend` | `user_append` | `system_append` |
  `tool_result` (a string; unknown values must be tolerated).
