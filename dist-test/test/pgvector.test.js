// Unit tests for the pgvector search helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { searchCollection, formatPgvectorResults } from "../src/pgvector.js";
function mockPool(rows = [], shouldThrow = false) {
    return {
        query: async (_sql, _params) => {
            if (shouldThrow)
                throw new Error("connection refused");
            return { rows };
        },
    };
}
describe("searchCollection", () => {
    it("returns mapped results on success", async () => {
        const pool = mockPool([
            {
                file_name: "doc.pdf",
                text: "hello",
                score: "0.95",
                mime_type: "application/pdf",
                file_id: "abc",
                source: "google_drive",
                owner: "olivier",
                chunk_index: 0,
                total_chunks: 1,
                timestamp_start: null,
                timestamp_end: null,
            },
            {
                file_name: "notes.md",
                text: "world",
                score: "0.80",
                mime_type: "text/markdown",
                file_id: "def",
                source: "google_drive",
                owner: "olivier",
                chunk_index: 0,
                total_chunks: 1,
                timestamp_start: null,
                timestamp_end: null,
            },
        ]);
        const results = await searchCollection(pool, "knowledge_test", [0.1, 0.2], 5, 0.3);
        assert.equal(results.length, 2);
        assert.equal(results[0].collection, "knowledge_test");
        assert.equal(results[0].score, 0.95);
        assert.equal(results[0].file_name, "doc.pdf");
        assert.equal(results[1].text, "world");
    });
    it("sends correct SQL with halfvec cast", async () => {
        let capturedSql = "";
        let capturedParams = [];
        const pool = {
            query: async (sql, params) => {
                capturedSql = sql;
                capturedParams = params;
                return { rows: [] };
            },
        };
        await searchCollection(pool, "my_col", [1, 2, 3], 10, 0.5);
        assert.ok(capturedSql.includes("halfvec(3072)"));
        assert.ok(capturedSql.includes("knowledge_vectors"));
        assert.equal(capturedParams[0], "[1,2,3]");
        assert.equal(capturedParams[1], "my_col");
        assert.equal(capturedParams[2], 10);
    });
    it("filters results below score threshold", async () => {
        const pool = mockPool([
            { file_name: "good.pdf", score: "0.8", text: "yes" },
            { file_name: "bad.pdf", score: "0.1", text: "no" },
        ]);
        const results = await searchCollection(pool, "col", [1], 5, 0.5);
        assert.equal(results.length, 1);
        assert.equal(results[0].file_name, "good.pdf");
    });
    it("returns empty array on database error", async () => {
        const pool = mockPool([], true);
        const results = await searchCollection(pool, "col", [1], 5, 0.3);
        assert.deepEqual(results, []);
    });
    it("handles empty result set", async () => {
        const pool = mockPool([]);
        const results = await searchCollection(pool, "col", [1], 5, 0.3);
        assert.deepEqual(results, []);
    });
});
describe("formatPgvectorResults", () => {
    it("returns null for empty results", () => {
        assert.equal(formatPgvectorResults([], 4000), null);
    });
    it("formats basic result with score and file name", () => {
        const results = [
            {
                collection: "knowledge",
                score: 0.95,
                file_name: "doc.pdf",
                text: "hello",
                mime_type: null,
                file_id: null,
                source: null,
                owner: null,
                chunk_index: null,
                total_chunks: null,
                timestamp_start: null,
                timestamp_end: null,
            },
        ];
        const output = formatPgvectorResults(results, 4000);
        assert.ok(output !== null);
        assert.ok(output.includes("[knowledge] doc.pdf (score: 0.95)"));
        assert.ok(output.includes("Content: hello"));
    });
    it("shows 'unknown' when file_name is missing", () => {
        const results = [
            {
                collection: "col",
                score: 0.5,
                text: "data",
                file_name: null,
                mime_type: null,
                file_id: null,
                source: null,
                owner: null,
                chunk_index: null,
                total_chunks: null,
                timestamp_start: null,
                timestamp_end: null,
            },
        ];
        const output = formatPgvectorResults(results, 4000);
        assert.ok(output.includes("[col] unknown (score: 0.50)"));
    });
    it("includes timestamps when present", () => {
        const results = [
            {
                collection: "videos",
                score: 0.88,
                file_name: "meeting.mp4",
                timestamp_start: "00:05:30",
                timestamp_end: "00:06:15",
                text: "important discussion",
                mime_type: null,
                file_id: null,
                source: null,
                owner: null,
                chunk_index: null,
                total_chunks: null,
            },
        ];
        const output = formatPgvectorResults(results, 4000);
        assert.ok(output.includes("Segment: 00:05:30 - 00:06:15"));
    });
    it("respects maxChars limit", () => {
        const results = Array.from({ length: 100 }, (_, i) => ({
            collection: "col",
            score: 0.9,
            file_name: `file${i}.pdf`,
            text: "x".repeat(100),
            mime_type: null,
            file_id: null,
            source: null,
            owner: null,
            chunk_index: null,
            total_chunks: null,
            timestamp_start: null,
            timestamp_end: null,
        }));
        const output = formatPgvectorResults(results, 500);
        assert.ok(output.length <= 500);
    });
    it("includes multiple results in order", () => {
        const results = [
            {
                collection: "a",
                score: 0.9,
                file_name: "first.pdf",
                text: "aaa",
                mime_type: null,
                file_id: null,
                source: null,
                owner: null,
                chunk_index: null,
                total_chunks: null,
                timestamp_start: null,
                timestamp_end: null,
            },
            {
                collection: "b",
                score: 0.8,
                file_name: "second.pdf",
                text: "bbb",
                mime_type: null,
                file_id: null,
                source: null,
                owner: null,
                chunk_index: null,
                total_chunks: null,
                timestamp_start: null,
                timestamp_end: null,
            },
        ];
        const output = formatPgvectorResults(results, 4000);
        const firstIdx = output.indexOf("first.pdf");
        const secondIdx = output.indexOf("second.pdf");
        assert.ok(firstIdx < secondIdx);
    });
});
//# sourceMappingURL=pgvector.test.js.map