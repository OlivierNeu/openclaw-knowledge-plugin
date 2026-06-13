// Unit tests for the Jina Classifier client + defensive response parser.

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFewShot,
  classifyZeroShot,
  parseClassificationResponse,
} from "../../src/jina/classifier.js";

const LABELS = ["NO_RETRIEVAL", "ACME_RETRIEVAL", "HYBRID"];

describe("classifyZeroShot — request shape", () => {
  afterEach(() => mock.restoreAll());

  it("posts to /v1/classify with model+input+labels and Bearer header", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> = {};

    mock.method(globalThis, "fetch", async (url: string | URL | Request, opts?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(opts?.body as string);
      capturedHeaders = opts?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({ data: [{ predictions: [{ label: "NO_RETRIEVAL", score: 0.91 }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await classifyZeroShot({
      apiKey: "jina_test",
      text: "Quel temps fait-il ?",
      labels: LABELS,
    });

    assert.equal(capturedUrl, "https://api.jina.ai/v1/classify");
    assert.equal(capturedHeaders["Authorization"], "Bearer jina_test");
    assert.deepEqual(capturedBody, {
      model: "jina-embeddings-v3",
      input: [{ text: "Quel temps fait-il ?" }],
      labels: LABELS,
    });
    assert.ok(result !== null);
    assert.equal(result!.label, "NO_RETRIEVAL");
    assert.equal(result!.score, 0.91);
  });

  it("rejects requests with fewer than 2 labels", async () => {
    await assert.rejects(
      () => classifyZeroShot({ apiKey: "k", text: "x", labels: ["only"] }),
      /at least 2 labels/,
    );
  });

  it("allows overriding the embedding model", async () => {
    let capturedBody: { model?: string } = {};
    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(JSON.stringify({ results: [{ label: "HYBRID", score: 0.7 }] }), {
        status: 200,
      });
    });

    await classifyZeroShot({
      apiKey: "k",
      text: "x",
      labels: LABELS,
      model: "jina-embeddings-v4",
    });
    assert.equal(capturedBody.model, "jina-embeddings-v4");
  });
});

describe("classifyFewShot — request shape", () => {
  afterEach(() => mock.restoreAll());

  it("posts to /v1/classify with classifier_id only (no model, no labels)", async () => {
    let capturedBody: Record<string, unknown> = {};

    mock.method(globalThis, "fetch", async (_url: unknown, opts?: RequestInit) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(
        JSON.stringify({ data: [{ predictions: [{ label: "HYBRID", score: 0.88 }] }] }),
        { status: 200 },
      );
    });

    const result = await classifyFewShot({
      apiKey: "k",
      text: "audit complet de la stack",
      classifierId: "openclaw-router-v1",
    });

    assert.equal(capturedBody["classifier_id"], "openclaw-router-v1");
    assert.deepEqual(capturedBody["input"], [{ text: "audit complet de la stack" }]);
    assert.equal(capturedBody["model"], undefined);
    assert.equal(capturedBody["labels"], undefined);
    assert.ok(result);
    assert.equal(result.label, "HYBRID");
  });

  it("rejects empty classifierId", async () => {
    await assert.rejects(
      () => classifyFewShot({ apiKey: "k", text: "x", classifierId: "" }),
      /classifierId is required/,
    );
  });

  it("filters out labels not in expectedLabels", async () => {
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({ results: [{ label: "ROGUE_LABEL", score: 1.0 }] }), {
        status: 200,
      }),
    );

    const result = await classifyFewShot({
      apiKey: "k",
      text: "x",
      classifierId: "id",
      expectedLabels: LABELS,
    });
    assert.equal(result, null);
  });
});

describe("parseClassificationResponse — defensive shape handling", () => {
  it("parses shape #1: data[].predictions[].label", () => {
    const r = parseClassificationResponse(
      { data: [{ predictions: [{ label: "NO_RETRIEVAL", score: 0.95 }] }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "NO_RETRIEVAL", score: 0.95 });
  });

  it("parses shape #2: results[].label", () => {
    const r = parseClassificationResponse(
      { results: [{ label: "HYBRID", score: 0.62 }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "HYBRID", score: 0.62 });
  });

  it("parses shape #3: data[].label (flat)", () => {
    const r = parseClassificationResponse(
      { data: [{ label: "ACME_RETRIEVAL", score: 0.81 }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "ACME_RETRIEVAL", score: 0.81 });
  });

  it("parses shape #4: data[].prediction + confidence aliases", () => {
    const r = parseClassificationResponse(
      { data: [{ prediction: "HYBRID", confidence: 0.5 }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "HYBRID", score: 0.5 });
  });

  it("returns null when score is missing — label still wins", () => {
    const r = parseClassificationResponse(
      { results: [{ label: "NO_RETRIEVAL" }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "NO_RETRIEVAL", score: null });
  });

  it("returns null when response is empty/garbage", () => {
    assert.equal(parseClassificationResponse({}, LABELS), null);
    assert.equal(parseClassificationResponse(null, LABELS), null);
    assert.equal(parseClassificationResponse("oops", LABELS), null);
    assert.equal(parseClassificationResponse({ data: [] }, LABELS), null);
    assert.equal(parseClassificationResponse({ results: [] }, LABELS), null);
  });

  it("returns null when label is not in allowedLabels", () => {
    const r = parseClassificationResponse(
      { results: [{ label: "INVENTED_BY_JINA", score: 0.99 }] },
      LABELS,
    );
    assert.equal(r, null);
  });

  it("accepts any non-empty label when allowedLabels is omitted (few-shot)", () => {
    const r = parseClassificationResponse(
      { results: [{ label: "CustomTrainedClass", score: 0.7 }] },
    );
    assert.deepEqual(r, { label: "CustomTrainedClass", score: 0.7 });
  });

  it("falls through shape #1 when predictions is empty and tries shape #3", () => {
    const r = parseClassificationResponse(
      { data: [{ predictions: [], label: "NO_RETRIEVAL", score: 0.5 }] },
      LABELS,
    );
    assert.deepEqual(r, { label: "NO_RETRIEVAL", score: 0.5 });
  });
});
