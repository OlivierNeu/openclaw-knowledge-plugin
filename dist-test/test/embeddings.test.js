// Unit tests for the Gemini embedding client.
//
// We stub `globalThis.fetch` via `node:test`'s mock utilities so the tests
// stay offline and deterministic.
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { embedQuery } from "../src/embeddings.js";
describe("embedQuery", () => {
    afterEach(() => {
        mock.restoreAll();
    });
    it("returns embedding values on success", async () => {
        const fakeValues = [0.1, 0.2, 0.3];
        mock.method(globalThis, "fetch", async () => ({
            ok: true,
            json: async () => ({ embedding: { values: fakeValues } }),
        }));
        const result = await embedQuery("test query", "fake-key");
        assert.deepEqual(result, fakeValues);
    });
    it("sends correct request to Gemini API", async () => {
        mock.method(globalThis, "fetch", async (url, opts) => {
            const urlStr = typeof url === "string" ? url : url.toString();
            assert.ok(urlStr.includes("gemini-embedding-2-preview:embedContent"));
            assert.ok(urlStr.includes("key=my-key"));
            assert.equal(opts?.method, "POST");
            const body = JSON.parse(opts?.body);
            assert.equal(body.content.parts[0].text, "hello world");
            return {
                ok: true,
                json: async () => ({ embedding: { values: [1] } }),
            };
        });
        await embedQuery("hello world", "my-key");
        const fetchMock = globalThis.fetch;
        assert.equal(fetchMock.mock.callCount(), 1);
    });
    it("throws on non-OK response", async () => {
        mock.method(globalThis, "fetch", async () => ({
            ok: false,
            status: 429,
            text: async () => "rate limited",
        }));
        await assert.rejects(() => embedQuery("q", "k"), {
            message: /Gemini embedding failed \(429\)/,
        });
    });
});
//# sourceMappingURL=embeddings.test.js.map