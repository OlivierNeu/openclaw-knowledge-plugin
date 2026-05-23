// Unit tests for the Jina HTTP client.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { postJson } from "../../src/jina/client.js";
import {
  JinaApiError,
  JinaAuthError,
  JinaError,
  JinaNetworkError,
  JinaRateLimitError,
  errorForStatus,
  previewBody,
  summarizeJinaError,
} from "../../src/jina/errors.js";

describe("postJson — happy path", () => {
  afterEach(() => mock.restoreAll());

  it("sends a POST with Bearer auth and JSON content type", async () => {
    let capturedUrl = "";
    let capturedOpts: RequestInit | undefined;

    mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedOpts = opts;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await postJson<{ hello: string }>({
      url: "https://api.jina.ai/v1/classify",
      body: { hello: "world" },
      apiKey: "jina_test",
    });

    assert.equal(capturedUrl, "https://api.jina.ai/v1/classify");
    assert.equal(capturedOpts?.method, "POST");
    const headers = capturedOpts?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["Authorization"], "Bearer jina_test");
    assert.equal(headers["Accept"], "application/json");
    const parsedBody = JSON.parse(capturedOpts?.body as string);
    assert.deepEqual(parsedBody, { hello: "world" });
    assert.deepEqual(result, { ok: true });
  });

  it("never leaks the API key in the URL", async () => {
    let capturedUrl = "";
    mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response("{}", { status: 200 });
    });

    await postJson({
      url: "https://api.jina.ai/v1/rerank",
      body: {},
      apiKey: "jina_supersecret",
    });

    assert.ok(!capturedUrl.includes("jina_supersecret"));
    assert.ok(!capturedUrl.includes("key="));
  });
});

describe("postJson — HTTP error mapping", () => {
  afterEach(() => mock.restoreAll());

  it("throws JinaAuthError on 401", async () => {
    mock.method(globalThis, "fetch", async () => new Response("invalid token", { status: 401 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaAuthError && err.message.includes("401"),
    );
  });

  it("throws JinaAuthError on 403", async () => {
    mock.method(globalThis, "fetch", async () => new Response("forbidden", { status: 403 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaAuthError && err.message.includes("403"),
    );
  });

  it("throws JinaRateLimitError on 429", async () => {
    mock.method(globalThis, "fetch", async () => new Response("rate limited", { status: 429 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaRateLimitError,
    );
  });

  it("throws JinaApiError on generic 5xx", async () => {
    mock.method(globalThis, "fetch", async () => new Response("oops", { status: 500 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaApiError && (err as JinaApiError).status === 500,
    );
  });

  it("throws JinaApiError when body is HTML (e.g. CDN 502 page)", async () => {
    const html = "<html><body>502 Bad Gateway from Cloudflare</body></html>";
    mock.method(globalThis, "fetch", async () => new Response(html, { status: 502 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaApiError && (err as JinaApiError).status === 502,
    );
  });

  it("truncates large error bodies to <= 200 chars in the message", async () => {
    const huge = "X".repeat(5_000);
    mock.method(globalThis, "fetch", async () => new Response(huge, { status: 500 }));
    try {
      await postJson({ url: "https://x/y", body: {}, apiKey: "k" });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof JinaError);
      // 200 chars from the body + the static "Jina request failed (500): " prefix
      assert.ok((err as Error).message.length < 300);
    }
  });
});

describe("postJson — parsing & timeout", () => {
  afterEach(() => mock.restoreAll());

  it("throws JinaApiError when a 200 response carries invalid JSON", async () => {
    mock.method(globalThis, "fetch", async () => new Response("not json at all", { status: 200 }));
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaApiError,
    );
  });

  it("throws JinaNetworkError when fetch throws", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("ECONNRESET");
    });
    await assert.rejects(
      () => postJson({ url: "https://x/y", body: {}, apiKey: "k" }),
      (err: unknown) => err instanceof JinaNetworkError,
    );
  });

  it("throws JinaNetworkError on timeout", async () => {
    // fetch that never resolves; the AbortController must fire the timeout.
    mock.method(globalThis, "fetch", (_url: unknown, opts?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await assert.rejects(
      () =>
        postJson({
          url: "https://x/y",
          body: {},
          apiKey: "k",
          timeoutMs: 30,
        }),
      (err: unknown) =>
        err instanceof JinaNetworkError && err.message.includes("timed out"),
    );
  });

  it("honors a caller-supplied AbortSignal", async () => {
    const controller = new AbortController();

    mock.method(globalThis, "fetch", (_url: unknown, opts?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const pending = postJson({
      url: "https://x/y",
      body: {},
      apiKey: "k",
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    setTimeout(() => controller.abort(), 20);

    await assert.rejects(pending, (err: unknown) => err instanceof JinaNetworkError);
  });

  it("aborts a slow body read when the timeout fires (headers-OK body-stalls)", async () => {
    // Regression — Codex review 2026-05-23.
    // Failure mode: headers arrive instantly but `resp.text()` never
    // resolves. The internal timeout MUST also cancel the body read,
    // otherwise the hook can hang for the SDK's outer timeout.
    mock.method(globalThis, "fetch", (_url: unknown, opts?: RequestInit) => {
      // Build a Response whose .text() never resolves on its own — only
      // the abort signal can cancel it. The signal forwarding mimics the
      // WHATWG fetch behavior: if the fetch's signal aborts, ongoing
      // body reads reject.
      const body = new ReadableStream({
        start(streamController) {
          opts?.signal?.addEventListener("abort", () => {
            streamController.error(new Error("aborted"));
          });
        },
      });
      const resp = new Response(body, { status: 200 });
      return Promise.resolve(resp);
    });

    const pending = postJson({
      url: "https://x/y",
      body: {},
      apiKey: "k",
      timeoutMs: 30,
    });

    await assert.rejects(
      pending,
      (err: unknown) =>
        err instanceof JinaNetworkError && err.message.includes("timed out"),
    );
  });
});

describe("error helpers", () => {
  it("previewBody truncates to 200 chars", () => {
    assert.equal(previewBody("short"), "short");
    assert.equal(previewBody("A".repeat(250)).length, 200);
  });

  it("errorForStatus picks the right subclass", () => {
    assert.ok(errorForStatus(401, "x") instanceof JinaAuthError);
    assert.ok(errorForStatus(403, "x") instanceof JinaAuthError);
    assert.ok(errorForStatus(429, "x") instanceof JinaRateLimitError);
    assert.ok(errorForStatus(500, "x") instanceof JinaApiError);
    assert.ok(errorForStatus(502, "x") instanceof JinaApiError);
  });

  it("error messages never contain the API key", () => {
    const errors = [
      new JinaApiError(500, "boom"),
      new JinaAuthError(401, "boom"),
      new JinaRateLimitError("boom"),
      new JinaNetworkError("boom"),
    ];
    for (const e of errors) {
      assert.ok(!e.message.includes("Bearer"));
      assert.ok(!e.message.includes("jina_"));
    }
  });
});

describe("summarizeJinaError (privacy-safe log summary)", () => {
  it("returns class name + status for JinaApiError, NEVER the body", () => {
    const err = new JinaApiError(503, "the user asked: secret PHI content here");
    const summary = summarizeJinaError(err);
    assert.equal(summary, "JinaApiError(status=503)");
    assert.ok(!summary.includes("secret"));
    assert.ok(!summary.includes("PHI"));
  });

  it("returns short class name for JinaAuthError", () => {
    assert.equal(summarizeJinaError(new JinaAuthError(401, "oh look an api key leaked")), "JinaAuthError");
  });

  it("returns short class name for JinaRateLimitError", () => {
    assert.equal(summarizeJinaError(new JinaRateLimitError("body echo here")), "JinaRateLimitError");
  });

  it("returns short class name for JinaNetworkError", () => {
    assert.equal(summarizeJinaError(new JinaNetworkError("timed out")), "JinaNetworkError");
  });

  it("falls back to error.name for non-Jina errors (never their message)", () => {
    const err = new TypeError("sensitive content somehow inside");
    const summary = summarizeJinaError(err);
    assert.equal(summary, "TypeError");
    assert.ok(!summary.includes("sensitive"));
  });

  it("handles unknown thrown values", () => {
    assert.equal(summarizeJinaError("not even an error"), "unknown-error");
    assert.equal(summarizeJinaError(42), "unknown-error");
    assert.equal(summarizeJinaError(null), "unknown-error");
  });
});
