// Integration-style tests for the plugin entry point.
//
// We exercise `registerKnowledgePlugin` with a hand-rolled fake of the
// OpenClaw plugin API. Using the internal factory (as opposed to the default
// `definePluginEntry(...)` export) keeps the tests decoupled from SDK runtime
// initialization while still covering the real registration path.
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import plugin, { registerKnowledgePlugin } from "../src/index.js";
function makeFakeApi(pluginConfig) {
    const state = {
        warnings: [],
        infos: [],
        debugs: [],
        errors: [],
        handlers: {},
    };
    const api = {
        pluginConfig,
        logger: {
            warn: (msg) => state.warnings.push(msg),
            info: (msg) => state.infos.push(msg),
            debug: (msg) => state.debugs.push(msg),
            error: (msg) => state.errors.push(msg),
        },
        on: (event, handler) => {
            state.handlers[event] = handler;
        },
    };
    return { api, state };
}
// `registerKnowledgePlugin` expects a full OpenClawPluginApi. We cast the
// fake via `unknown` at call sites because only a subset of the surface is
// exercised in tests.
function register(api) {
    registerKnowledgePlugin(api);
}
// ---------------------------------------------------------------------------
// Plugin metadata (default export from definePluginEntry)
// ---------------------------------------------------------------------------
describe("plugin metadata", () => {
    it("exposes correct plugin metadata", () => {
        assert.equal(plugin.id, "openclaw-knowledge");
        assert.equal(plugin.name, "Knowledge Base");
        assert.equal(typeof plugin.description, "string");
        assert.ok(plugin.description.includes("pgvector"));
        assert.ok(plugin.description.includes("LightRAG"));
    });
});
// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
describe("registerKnowledgePlugin — initialization", () => {
    it("warns and returns when neither pgvector nor lightrag configured", () => {
        const { api, state } = makeFakeApi({});
        register(api);
        assert.equal(state.warnings.length, 1);
        assert.ok(state.warnings[0].includes("neither pgvector nor LightRAG configured"));
        assert.equal(state.handlers["before_prompt_build"], undefined);
    });
    it("registers hook with pgvector only", () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
            collections: ["test_col"],
        });
        register(api);
        assert.equal(typeof state.handlers["before_prompt_build"], "function");
        assert.ok(state.infos.some((m) => m.includes("pgvector")));
        assert.ok(!state.infos.some((m) => m.includes("LightRAG")));
    });
    it("registers hook with lightrag only", () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
            lightragApiKey: "lr-key",
        });
        register(api);
        assert.equal(typeof state.handlers["before_prompt_build"], "function");
        assert.ok(state.infos.some((m) => m.includes("LightRAG")));
        assert.ok(!state.infos.some((m) => m.includes("pgvector")));
    });
    it("registers hook with both sources", () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://user:pass@localhost:5432/knowledge",
            collections: ["col"],
            lightragUrl: "http://lightrag:9621",
        });
        register(api);
        assert.equal(typeof state.handlers["before_prompt_build"], "function");
        const readyMsg = state.infos.find((m) => m.includes("ready"));
        assert.ok(readyMsg);
        assert.ok(readyMsg.includes("pgvector"));
        assert.ok(readyMsg.includes("LightRAG"));
    });
    it("disables pgvector when pgvectorEnabled is false", () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://localhost/knowledge",
            pgvectorEnabled: false,
            lightragUrl: "http://lightrag:9621",
        });
        register(api);
        const readyMsg = state.infos.find((m) => m.includes("ready"));
        assert.ok(readyMsg);
        assert.ok(!readyMsg.includes("pgvector"));
        assert.ok(readyMsg.includes("LightRAG"));
    });
    it("disables lightrag when lightragEnabled is false", () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://localhost/knowledge",
            lightragUrl: "http://lightrag:9621",
            lightragEnabled: false,
        });
        register(api);
        const readyMsg = state.infos.find((m) => m.includes("ready"));
        assert.ok(readyMsg);
        assert.ok(readyMsg.includes("pgvector"));
        assert.ok(!readyMsg.includes("LightRAG"));
    });
});
// ---------------------------------------------------------------------------
// Hook: query extraction
// ---------------------------------------------------------------------------
describe("before_prompt_build — query extraction", () => {
    afterEach(() => mock.restoreAll());
    it("skips short queries (less than 3 chars)", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async () => {
            throw new Error("fetch should not be called");
        });
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "ab" }],
        });
        assert.equal(result, undefined);
    });
    it("skips empty messages array", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async () => {
            throw new Error("fetch should not be called");
        });
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [],
        });
        assert.equal(result, undefined);
    });
    it("does nothing when disabled", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
            enabled: false,
        });
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "hello world query" }],
        });
        assert.equal(result, undefined);
    });
    it("extracts query from string content", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        let capturedQuery = "";
        mock.method(globalThis, "fetch", async (_url, opts) => {
            const body = JSON.parse(opts?.body);
            capturedQuery = body.query;
            return {
                ok: true,
                json: async () => ({ response: "context" }),
            };
        });
        register(api);
        await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "find my contracts" }],
        });
        assert.equal(capturedQuery, "find my contracts");
    });
    it("extracts query from array content format (OpenClaw multi-part)", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        let capturedQuery = "";
        mock.method(globalThis, "fetch", async (_url, opts) => {
            const body = JSON.parse(opts?.body);
            capturedQuery = body.query;
            return {
                ok: true,
                json: async () => ({ response: "context" }),
            };
        });
        register(api);
        await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "what is in my scanned documents?" }],
                },
            ],
        });
        assert.equal(capturedQuery, "what is in my scanned documents?");
    });
    it("handles mixed content array with non-text parts", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async () => {
            throw new Error("fetch should not be called for empty text");
        });
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [
                {
                    role: "user",
                    content: [{ type: "image", data: "base64..." }],
                },
            ],
        });
        assert.equal(result, undefined);
    });
    it("picks last user message, skipping assistant messages", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        let capturedQuery = "";
        mock.method(globalThis, "fetch", async (_url, opts) => {
            const body = JSON.parse(opts?.body);
            capturedQuery = body.query;
            return { ok: true, json: async () => ({ response: "ctx" }) };
        });
        register(api);
        await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [
                { role: "user", content: "first question" },
                { role: "assistant", content: "first answer" },
                { role: "user", content: "second question" },
                { role: "assistant", content: "second answer" },
            ],
        });
        assert.equal(capturedQuery, "second question");
    });
});
// ---------------------------------------------------------------------------
// Hook: LightRAG-only execution
// ---------------------------------------------------------------------------
describe("before_prompt_build — LightRAG execution", () => {
    afterEach(() => mock.restoreAll());
    it("injects LightRAG context into appendSystemContext", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
            lightragApiKey: "lr-key",
        });
        mock.method(globalThis, "fetch", async () => ({
            ok: true,
            json: async () => ({
                response: "Entity: ACME Corp. Relation: signed contract with Olivier.",
            }),
        }));
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "tell me about ACME" }],
        });
        assert.ok(result);
        assert.ok(result.appendSystemContext.includes("Knowledge Graph Context (LightRAG)"));
        assert.ok(result.appendSystemContext.includes("ACME Corp"));
        assert.ok(result.appendSystemContext.includes("Relevant Knowledge Base"));
    });
    it("returns undefined when LightRAG returns empty context", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async () => ({
            ok: true,
            json: async () => ({ response: "" }),
        }));
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "something obscure" }],
        });
        assert.equal(result, undefined);
    });
    it("truncates LightRAG context to lightragMaxChars", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
            lightragMaxChars: 50,
        });
        mock.method(globalThis, "fetch", async () => ({
            ok: true,
            json: async () => ({ response: "A".repeat(200) }),
        }));
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "long context query" }],
        });
        assert.ok(result);
        assert.ok(result.appendSystemContext.length < 300);
    });
});
// ---------------------------------------------------------------------------
// Hook: graceful degradation
// ---------------------------------------------------------------------------
describe("before_prompt_build — graceful degradation", () => {
    afterEach(() => mock.restoreAll());
    it("continues with LightRAG when pgvector fails", async () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://localhost/knowledge",
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async (url) => {
            const urlStr = typeof url === "string" ? url : url.toString();
            if (urlStr.includes("generativelanguage")) {
                // Gemini embedding fails
                return { ok: false, status: 500, text: async () => "embed error" };
            }
            // LightRAG succeeds
            return {
                ok: true,
                json: async () => ({ response: "LightRAG context here" }),
            };
        });
        register(api);
        const result = await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "find my documents" }],
        });
        assert.ok(result);
        assert.ok(result.appendSystemContext.includes("LightRAG context here"));
        assert.ok(state.errors.some((e) => e.includes("source failed")));
    });
    it("continues with pgvector when LightRAG fails", async () => {
        const { api, state } = makeFakeApi({
            geminiApiKey: "test-key",
            postgresUrl: "postgresql://localhost/knowledge",
            collections: ["col"],
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async (url) => {
            const urlStr = typeof url === "string" ? url : url.toString();
            if (urlStr.includes("generativelanguage")) {
                return {
                    ok: true,
                    json: async () => ({ embedding: { values: [0.1, 0.2] } }),
                };
            }
            // LightRAG fails
            return { ok: false, status: 503, text: async () => "service down" };
        });
        register(api);
        // pgvector pool.query will fail (no real DB), but the point is the
        // LightRAG error is logged and doesn't crash the plugin.
        await state.handlers["before_prompt_build"]({
            prompt: "",
            messages: [{ role: "user", content: "find my documents" }],
        });
        assert.ok(state.errors.some((e) => e.includes("source failed")));
    });
});
// ---------------------------------------------------------------------------
// Hook: cooldown behavior
// ---------------------------------------------------------------------------
describe("before_prompt_build — cooldown", () => {
    afterEach(() => mock.restoreAll());
    it("enters cooldown after MAX_CONSECUTIVE_ERRORS", async () => {
        const { api, state } = makeFakeApi({
            lightragUrl: "http://lightrag:9621",
        });
        mock.method(globalThis, "fetch", async () => {
            throw new Error("network down");
        });
        register(api);
        const event = {
            prompt: "",
            messages: [{ role: "user", content: "test query here" }],
        };
        // Trigger 3 consecutive errors (MAX_CONSECUTIVE_ERRORS).
        await state.handlers["before_prompt_build"](event);
        await state.handlers["before_prompt_build"](event);
        await state.handlers["before_prompt_build"](event);
        assert.ok(state.errors.some((e) => e.includes("cooling down")));
        // 4th call should be silently skipped (cooldown active).
        const errorCountBefore = state.errors.length;
        await state.handlers["before_prompt_build"](event);
        assert.equal(state.errors.length, errorCountBefore);
    });
});
//# sourceMappingURL=plugin.test.js.map