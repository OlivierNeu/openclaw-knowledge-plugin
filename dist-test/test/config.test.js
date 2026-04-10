// Unit tests for config helpers (resolveEnv + resolveConfig).
//
// Uses Node's built-in test runner so we stay dependency-free.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveEnv, resolveConfig } from "../src/config.js";
describe("resolveEnv", () => {
    beforeEach(() => {
        process.env.TEST_KEY = "hello";
        process.env.OTHER_KEY = "world";
    });
    afterEach(() => {
        delete process.env.TEST_KEY;
        delete process.env.OTHER_KEY;
    });
    it("returns non-string values as-is", () => {
        assert.equal(resolveEnv(42), 42);
        assert.equal(resolveEnv(null), null);
        assert.equal(resolveEnv(undefined), undefined);
        assert.equal(resolveEnv(true), true);
    });
    it("replaces ${VAR} with env value", () => {
        assert.equal(resolveEnv("${TEST_KEY}"), "hello");
    });
    it("replaces multiple variables", () => {
        assert.equal(resolveEnv("${TEST_KEY}-${OTHER_KEY}"), "hello-world");
    });
    it("replaces missing variables with empty string", () => {
        assert.equal(resolveEnv("${NONEXISTENT_VAR}"), "");
    });
    it("returns plain strings unchanged", () => {
        assert.equal(resolveEnv("no vars here"), "no vars here");
    });
});
describe("resolveConfig", () => {
    it("applies defaults for an empty config", () => {
        const cfg = resolveConfig({});
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.topK, 5);
        assert.equal(cfg.scoreThreshold, 0.3);
        assert.equal(cfg.maxInjectChars, 4000);
        assert.equal(cfg.lightragQueryMode, "hybrid");
        assert.equal(cfg.lightragMaxChars, 4000);
        assert.deepEqual(cfg.collections, ["knowledge_default"]);
    });
    it("derives pgvectorEnabled from presence of geminiApiKey", () => {
        const without = resolveConfig({});
        assert.equal(without.pgvectorEnabled, false);
        const withKey = resolveConfig({ geminiApiKey: "k" });
        assert.equal(withKey.pgvectorEnabled, true);
    });
    it("honors explicit pgvectorEnabled=false even with geminiApiKey", () => {
        const cfg = resolveConfig({ geminiApiKey: "k", pgvectorEnabled: false });
        assert.equal(cfg.pgvectorEnabled, false);
    });
    it("derives lightragEnabled from presence of lightragUrl", () => {
        const without = resolveConfig({});
        assert.equal(without.lightragEnabled, false);
        const withUrl = resolveConfig({ lightragUrl: "http://lr:9621" });
        assert.equal(withUrl.lightragEnabled, true);
    });
    it("honors explicit lightragEnabled=false even with lightragUrl", () => {
        const cfg = resolveConfig({
            lightragUrl: "http://lr:9621",
            lightragEnabled: false,
        });
        assert.equal(cfg.lightragEnabled, false);
    });
    it("accepts null/undefined config", () => {
        assert.doesNotThrow(() => resolveConfig(null));
        assert.doesNotThrow(() => resolveConfig(undefined));
    });
});
//# sourceMappingURL=config.test.js.map