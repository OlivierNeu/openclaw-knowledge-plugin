// Unit tests for the LightRAG client helpers.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  queryLightRAG,
  truncateLightRAG,
  parseLightRAGReferences,
  normalizeReferenceContent,
  extractDocumentTitle,
  LightRAGTimeoutError,
} from "../src/lightrag.js";

describe("queryLightRAG", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("sends correct request to LightRAG API", async () => {
    mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      assert.equal(urlStr, "http://lightrag:9621/query");
      assert.equal(opts?.method, "POST");
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(headers["X-API-Key"], "my-api-key");

      const body = JSON.parse(opts?.body as string);
      assert.equal(body.query, "find my contracts");
      assert.equal(body.mode, "hybrid");
      assert.equal(body.only_need_context, true);
      assert.equal(body.stream, false);
      // 3.2.12: when requested (provenance=full), LightRAG returns per-reference
      // chunk content; without it, references are id+path only — which is exactly
      // why the Sources panel showed no per-doc text.
      assert.equal(body.include_chunk_content, true);

      return {
        ok: true,
        json: async () => ({ response: "Contract A signed on 2025-01-01." }),
      } as unknown as Response;
    });

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "my-api-key",
      "find my contracts",
      "hybrid",
      true, // includeChunkContent (caller enables only at provenance=full)
    );
    assert.equal(result.context, "Contract A signed on 2025-01-01.");
    assert.deepEqual(result.references, []);
  });

  it("does NOT request chunk content by default (gated on provenance=full)", async () => {
    let sentFlag: unknown = "unset";
    mock.method(globalThis, "fetch", async (_u: unknown, opts?: RequestInit) => {
      sentFlag = JSON.parse(opts?.body as string).include_chunk_content;
      return { ok: true, json: async () => ({ response: "ctx" }) } as unknown as Response;
    });
    // No 5th arg → off/metadata path: must NOT pay for chunk content.
    await queryLightRAG("http://lightrag:9621", "", "q", "hybrid");
    assert.equal(sentFlag, false);
  });

  it("returns empty context when response field is missing", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ other: "data" }),
    }) as unknown as Response);

    const result = await queryLightRAG(
      "http://lightrag:9621",
      "",
      "query",
      "global",
    );
    assert.equal(result.context, "");
    assert.deepEqual(result.references, []);
  });

  it("falls back to the `context` field when `response` is absent", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({ context: "via context field" }),
    }) as unknown as Response);

    const result = await queryLightRAG("http://lightrag:9621", "", "q", "hybrid");
    assert.equal(result.context, "via context field");
  });

  it("extracts structured source references from the response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: true,
      json: async () => ({
        response: "Context with two sources.",
        // Real shape with include_chunk_content:true — content is a string[] of
        // chunks (HKUDS/LightRAG >= 1.4.9), no per-reference score.
        references: [
          {
            reference_id: "1",
            file_path: "offre-1.md",
            content: ["Retrieved chunk one.", "Retrieved chunk two."],
          },
          { reference_id: "2", file_path: "offre-2.md" },
        ],
      }),
    }) as unknown as Response);

    const result = await queryLightRAG("http://lightrag:9621", "", "q", "hybrid");
    assert.equal(result.context, "Context with two sources.");
    // 3.2.12: the per-document retrieved chunks are captured + joined (the user must
    // see the source material the RAG pulled), not dropped.
    assert.deepEqual(result.references, [
      {
        file_path: "offre-1.md",
        reference_id: "1",
        content: "Retrieved chunk one.\n\nRetrieved chunk two.",
      },
      { file_path: "offre-2.md", reference_id: "2" },
    ]);
  });
});

describe("extractDocumentTitle", () => {
  it("reads the n8n `File Name:` metadata header line (the readable name)", () => {
    const content =
      "--- Document Metadata ---\nFile Name: 2026 03 30 — Antoine Delcampe — CR.docx\nSource: Google Drive\nFile ID: 1AbC\n---\n\nCorps du document...";
    assert.equal(
      extractDocumentTitle(content),
      "2026 03 30 — Antoine Delcampe — CR.docx",
    );
  });
  it("returns undefined with no header / empty name (item falls back to file_name)", () => {
    assert.equal(extractDocumentTitle("a mid-document chunk, no header"), undefined);
    assert.equal(extractDocumentTitle(undefined), undefined);
    assert.equal(extractDocumentTitle("File Name:   "), undefined);
  });
  it("ignores a `File Name:` line OUTSIDE the metadata header (no body-content leak)", () => {
    // A mid-document chunk with a business line — must NOT be surfaced as a title.
    assert.equal(
      extractDocumentTitle("Voici le tableau.\nFile Name: facture-client.pdf\n(suite)"),
      undefined,
    );
    // The header's File Name wins; a stray body line after the header is ignored.
    const both =
      "--- Document Metadata ---\nFile Name: Vrai Titre.docx\n---\n\nFile Name: piege-du-corps.txt";
    assert.equal(extractDocumentTitle(both), "Vrai Titre.docx");
    // The marker must be at the START — a mid-chunk that merely CONTAINS it is ignored.
    const midChunk =
      "Texte du corps...\n--- Document Metadata ---\nFile Name: faux-titre.docx\n---";
    assert.equal(extractDocumentTitle(midChunk), undefined);
  });
});

describe("normalizeReferenceContent", () => {
  it("joins a string[] of chunks (the real include_chunk_content shape)", () => {
    assert.equal(
      normalizeReferenceContent(["chunk A", "chunk B"]),
      "chunk A\n\nchunk B",
    );
  });
  it("accepts a bare string defensively, drops empties", () => {
    assert.equal(normalizeReferenceContent("solo"), "solo");
    assert.equal(normalizeReferenceContent(["", "kept", ""]), "kept");
  });
  it("returns undefined for empty / non-string input", () => {
    assert.equal(normalizeReferenceContent([]), undefined);
    assert.equal(normalizeReferenceContent(undefined), undefined);
    assert.equal(normalizeReferenceContent([1, 2]), undefined);
    assert.equal(normalizeReferenceContent(42), undefined);
  });
});

describe("parseLightRAGReferences", () => {
  it("returns [] for non-array / missing input", () => {
    assert.deepEqual(parseLightRAGReferences(undefined), []);
    assert.deepEqual(parseLightRAGReferences(null), []);
    assert.deepEqual(parseLightRAGReferences("nope"), []);
    assert.deepEqual(parseLightRAGReferences({}), []);
  });

  it("keeps only entries with a non-empty string file_path", () => {
    const refs = parseLightRAGReferences([
      { reference_id: "1", file_path: "a.md" },
      { reference_id: "2", file_path: "" }, // empty → dropped
      { reference_id: "3" }, // no file_path → dropped
      { file_path: "b.md" }, // no reference_id → kept, id omitted
      "not-an-object", // → dropped
      null, // → dropped
      { file_path: 42 }, // non-string → dropped
    ]);
    assert.deepEqual(refs, [
      { file_path: "a.md", reference_id: "1" },
      { file_path: "b.md" },
    ]);
  });

  it("omits a non-string reference_id", () => {
    const refs = parseLightRAGReferences([{ reference_id: 5, file_path: "a.md" }]);
    assert.deepEqual(refs, [{ file_path: "a.md" }]);
  });

  it("captures + joins the per-document chunk content array (3.2.12)", () => {
    const refs = parseLightRAGReferences([
      { file_path: "a.md", content: ["chunk one", "chunk two"] },
      { file_path: "b.md" }, // no content → omitted
    ]);
    assert.deepEqual(refs, [
      { file_path: "a.md", content: "chunk one\n\nchunk two" },
      { file_path: "b.md" },
    ]);
  });

  it("defensively omits malformed content (non-string array entries, empties)", () => {
    const refs = parseLightRAGReferences([
      { file_path: "a.md", content: [1, 2] }, // non-string entries → omitted
      { file_path: "b.md", content: [] }, // empty → omitted
    ]);
    assert.deepEqual(refs, [{ file_path: "a.md" }, { file_path: "b.md" }]);
  });

  it("omits X-API-Key header when no API key", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const headers = opts?.headers as Record<string, string>;
      assert.equal(headers["X-API-Key"], undefined);
      return { ok: true, json: async () => ({ response: "ok" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "hybrid");
  });

  it("uses provided query mode", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      assert.equal(body.mode, "global");
      return { ok: true, json: async () => ({ response: "" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query", "global");
  });

  it("defaults to hybrid mode when none specified", async () => {
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      const body = JSON.parse(opts?.body as string);
      assert.equal(body.mode, "hybrid");
      return { ok: true, json: async () => ({ response: "" }) } as unknown as Response;
    });

    await queryLightRAG("http://lightrag:9621", "", "query");
  });

  it("throws on non-OK response", async () => {
    mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as Response);

    await assert.rejects(
      () => queryLightRAG("http://lightrag:9621", "", "q", "hybrid"),
      { message: /LightRAG query failed \(500\)/ },
    );
  });
});

describe("truncateLightRAG", () => {
  it("returns empty string unchanged", () => {
    assert.equal(truncateLightRAG("", 100), "");
  });

  it("returns short text unchanged", () => {
    assert.equal(truncateLightRAG("short text.", 1000), "short text.");
  });

  it("truncates at last period when possible", () => {
    const text =
      "First sentence. Second sentence. Third sentence is very long.";
    const result = truncateLightRAG(text, 35);
    assert.equal(result, "First sentence. Second sentence.");
  });

  it("truncates at maxChars when no good period found", () => {
    const text = "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    assert.equal(result.length, 100);
  });

  it("does not cut at period too early in the text", () => {
    // Period at position 2 in a 100-char max — too early (< 50%)
    const text = "Hi. " + "A".repeat(200);
    const result = truncateLightRAG(text, 100);
    // Should fall back to raw truncation since period is at pos 2 (< 50 = 50%)
    assert.equal(result.length, 100);
  });
});

describe("queryLightRAG — 4.0 options", () => {
  afterEach(() => mock.restoreAll());

  it("does not pass a signal when no timeout / signal is requested (legacy shape)", async () => {
    let init: RequestInit | undefined;
    mock.method(globalThis, "fetch", async (_u: unknown, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    });
    await queryLightRAG("http://lr:9621", "", "q", "hybrid");
    assert.equal(init?.signal, undefined);
  });

  it("aborts after timeoutMs with a LightRAGTimeoutError", async () => {
    mock.method(
      globalThis,
      "fetch",
      (_u: unknown, i?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // AbortSignal.timeout() is unref'd: without a pending ref'd timer the
          // event loop drains first and the runner cancels the test (Node 22).
          const keepAlive = setTimeout(() => undefined, 5_000);
          i?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(i.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    await assert.rejects(
      () => queryLightRAG("http://lr:9621", "", "q", "hybrid", false, { timeoutMs: 30 }),
      (err: unknown) => err instanceof LightRAGTimeoutError && /timed out after 30ms/.test(err.message),
    );
  });

  it("reports a caller abort as a budget abort", async () => {
    mock.method(
      globalThis,
      "fetch",
      (_u: unknown, i?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // AbortSignal.timeout() is unref'd: without a pending ref'd timer the
          // event loop drains first and the runner cancels the test (Node 22).
          const keepAlive = setTimeout(() => undefined, 5_000);
          i?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(i.signal!.reason);
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = queryLightRAG("http://lr:9621", "", "q", "hybrid", false, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => err instanceof LightRAGTimeoutError && /budget/.test(err.message));
  });

  it("sends hl/ll keywords for graph modes only", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mock.method(globalThis, "fetch", async (_u: unknown, i?: RequestInit) => {
      bodies.push(JSON.parse(String(i?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    });
    const keywords = { hl: ["projet hélios"], ll: ["Hélios", "ACME"] };
    await queryLightRAG("http://lr:9621", "", "q", "hybrid", false, { keywords });
    await queryLightRAG("http://lr:9621", "", "q", "naive", false, { keywords });
    await queryLightRAG("http://lr:9621", "", "q", "mix", false, { keywords: { hl: [], ll: [] } });
    assert.deepEqual(bodies[0]!.hl_keywords, ["projet hélios"]);
    assert.deepEqual(bodies[0]!.ll_keywords, ["Hélios", "ACME"]);
    assert.equal("hl_keywords" in bodies[1]!, false);
    assert.equal("hl_keywords" in bodies[2]!, false);
  });
});
