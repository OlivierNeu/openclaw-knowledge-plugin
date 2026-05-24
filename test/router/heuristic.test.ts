// Unit tests for the zero-cost router heuristics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { heuristicRoute, NON_USER_TRIGGERS } from "../../src/router/heuristic.js";

describe("heuristicRoute — trigger gating", () => {
  it("returns NONE on heartbeat trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "heartbeat" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("returns NONE on cron trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "cron" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("returns NONE on memory trigger", () => {
    const v = heuristicRoute({ query: "anything", trigger: "memory" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("does NOT skip on user trigger", () => {
    const v = heuristicRoute({ query: "what is in my drive?", trigger: "user" });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip when trigger is undefined", () => {
    const v = heuristicRoute({ query: "what is in my drive?" });
    assert.notEqual(v.route, "NONE");
  });

  it("NON_USER_TRIGGERS contains exactly the three documented values", () => {
    assert.deepEqual(
      [...NON_USER_TRIGGERS].sort(),
      ["cron", "heartbeat", "memory"],
    );
  });
});

describe("heuristicRoute — meta-agent regex", () => {
  it("skips 'quel est ton identifiant de session'", () => {
    const v = heuristicRoute({ query: "Quel est ton identifiant de session ?" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });

  it("skips 'session id'", () => {
    const v = heuristicRoute({ query: "what is your session id?" });
    assert.equal(v.route, "NONE");
  });

  it("skips 'combien d'agents'", () => {
    const v = heuristicRoute({ query: "combien d'agent et subagent dans cette instance" });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });

  it("skips 'who are you'", () => {
    assert.equal(heuristicRoute({ query: "who are you?" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "qui es-tu" }).route, "NONE");
  });

  it("does NOT skip a legitimate question that mentions 'session' in a business sense", () => {
    const v = heuristicRoute({
      query: "résume les notes de la session du 28 mai avec Maurice",
    });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip business questions ending with 'status' (Codex review regression)", () => {
    // The "status" trigger MUST be anchored to the whole-prompt; otherwise
    // every project / mission / ticket status question gets dropped.
    const queries = [
      "what is the ACME project status?",
      "quel est le statut de la mission Saint-Gratien ?",
      "donne-moi le status du programme 2026",
      "is the deployment status ok",
    ];
    for (const q of queries) {
      const v = heuristicRoute({ query: q });
      assert.notEqual(v.route, "NONE", `"${q}" was incorrectly classified as meta`);
    }
  });

  it("DOES skip a bare 'status?' system ping", () => {
    assert.equal(heuristicRoute({ query: "status?" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "status" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "system status" }).route, "NONE");
    assert.equal(heuristicRoute({ query: "the system status?" }).route, "NONE");
  });

  it("skips OWUI auto-prompts that ship the full 4-section template", () => {
    // OWUI title / tags / follow-up / summary tasks all end with the
    // canonical four-section structure:
    //   ### Task:        — header
    //   ### Output:      — JSON format directive
    //   ### Chat History: — section header (literal)
    //   <chat_history>…</chat_history>  — XML block at end-of-prompt
    // The full shape is what we anchor on (see code comment in
    // heuristic.ts for the rejected weaker signals).
    const owuiChatHistoryTail =
      "### Chat History:\n<chat_history>\n" +
      "USER: Quelle est la version du plugin ?\nASSISTANT: 3.2.3\n" +
      "</chat_history>";

    const titleGen =
      "### Task:\nGenerate a concise, 3-5 word title with an emoji " +
      "summarizing the chat history.\n" +
      '### Output:\nJSON format: { "title": "your concise title here" }\n' +
      owuiChatHistoryTail;
    const tagsGen =
      "### Task:\nGenerate 1-3 broad tags categorizing the main themes.\n" +
      '### Output:\nJSON format: { "tags": ["tag1", "tag2"] }\n' +
      owuiChatHistoryTail;
    const followupGen =
      "### Task:\nSuggest 3-5 relevant follow-up questions.\n" +
      '### Output:\nJSON format: { "follow_ups": [...] }\n' +
      owuiChatHistoryTail;
    const summaryGen =
      "### Task:\nCreate a short summary of the conversation.\n" +
      '### Output:\nJSON format: { "summary": "..." }\n' +
      owuiChatHistoryTail;

    for (const q of [titleGen, tagsGen, followupGen, summaryGen]) {
      const v = heuristicRoute({ query: q });
      assert.equal(v.route, "NONE", `"${q.slice(0, 40)}..." should be classified meta`);
      assert.equal(v.reason, "heuristic_meta");
    }
  });

  it("does NOT skip a real `### Task:` prompt WITHOUT the OWUI chat_history block", () => {
    // Codex pass #28 P2 regression: a power user can legitimately write
    // a structured task prompt that lacks the OWUI XML chat_history
    // marker. Those MUST reach the router/sources, not be silently
    // dropped.
    const realTaskPrompts = [
      "### Task:\nCreate a migration plan from the docs.",
      "### Task:\nGenerate a list of pending refactors in the auth module.",
      "### Task:\nSuggest improvements to the deployment pipeline.",
      "### Task:\nCreate a summary of the last release.\n\n(no JSON output, just prose)",
    ];
    for (const q of realTaskPrompts) {
      const v = heuristicRoute({ query: q });
      assert.notEqual(
        v.route,
        "NONE",
        `"${q.slice(0, 60)}..." should NOT be classified as OWUI metadata`,
      );
    }
  });

  it("does NOT skip a structured JSON-output user task with a non-OWUI key (Codex pass #29 P2)", () => {
    // Codex pass #29 P2 regression: any structured task that asks for
    // JSON output of a DOMAIN key MUST reach the knowledge sources.
    // None of these prompts ship the OWUI `<chat_history>` block so
    // they are passed through.
    const realDomainTasks = [
      "### Task:\nExtract all client names from the docs.\n" +
        '### Output:\nJSON format: { "clients": ["..."] }',
      "### Task:\nList the upcoming milestones from the project plans.\n" +
        '### Output:\nJSON format: { "milestones": [{"date": "...", "name": "..."}] }',
      "### Task:\nAnswer the user question from the provided context.\n" +
        '### Output:\nJSON format: { "answer": "...", "sources": [...] }',
      "### Task:\nExtract entities and their relations from the corpus.\n" +
        '### Output:\nJSON format: { "entities": [...], "relations": [...] }',
    ];
    for (const q of realDomainTasks) {
      const v = heuristicRoute({ query: q });
      assert.notEqual(
        v.route,
        "NONE",
        `"${q.slice(0, 60)}..." should NOT be classified as OWUI metadata`,
      );
    }
  });

  it("does NOT skip a user task that asks for `{ summary: ... }` from the docs (Codex pass #30 P2)", () => {
    // Codex pass #30 P2 regression: even the four canonical OWUI keys
    // (title / tags / follow_ups / summary) are NOT discriminant on
    // their own. A user can legitimately ask for a `summary` of
    // documents, or `tags` for an article, in JSON output. None of
    // these prompts injects the `<chat_history>` block, so they MUST
    // reach the knowledge sources.
    const ambiguousButLegit = [
      "### Task:\nSummarize the latest Ataraxis CR meeting.\n" +
        '### Output:\nJSON format: { "summary": "...", "decisions": [...] }',
      "### Task:\nAssign tags to the IFOA V5 document.\n" +
        '### Output:\nJSON format: { "tags": ["...", "..."] }',
      "### Task:\nPropose a chapter title for the report.\n" +
        '### Output:\nJSON format: { "title": "..." }',
      "### Task:\nSuggest follow-up questions for the prospect call.\n" +
        '### Output:\nJSON format: { "follow_ups": ["..."] }',
    ];
    for (const q of ambiguousButLegit) {
      const v = heuristicRoute({ query: q });
      assert.notEqual(
        v.route,
        "NONE",
        `"${q.slice(0, 60)}..." should NOT be classified as OWUI metadata`,
      );
    }
  });

  it("does NOT skip a user task that pastes the OWUI chat_history but adds a question after (Codex pass #31 P2)", () => {
    // Codex pass #31 P2 regression: a user can paste an example
    // OWUI-style block as CONTEXT and then ASK something after it.
    // The end-of-prompt anchor `\s*$` defeats the match because the
    // user's question follows the closing `</chat_history>` tag.
    const pasteThenAsk =
      "### Task:\nAnalyse ce template Open WebUI\n" +
      "### Output:\nJSON format: { ... }\n" +
      "### Chat History:\n<chat_history>\nUSER: foo\nASSISTANT: bar\n</chat_history>\n\n" +
      "Comment puis-je désactiver ces appels automatiques côté gateway ?";
    const v = heuristicRoute({ query: pasteThenAsk });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip a user task that embeds <chat_history> without the OWUI section header (Codex pass #31 P2)", () => {
    // Variant: the user pastes a `<chat_history>` block as inline
    // example but does NOT reproduce the OWUI `### Chat History:`
    // section header preceding it. Without all four structural
    // markers, the pattern stays inactive.
    const inlineXmlExample =
      "### Task:\nAnalyse ce template Open WebUI\n" +
      "### Output:\nJSON format: { ... }\n" +
      "Voici un exemple inline: <chat_history>USER: x\nASSISTANT: y</chat_history>";
    const v = heuristicRoute({ query: inlineXmlExample });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip when the OWUI template appears mid-body (anchored on `^`)", () => {
    // A user quoting the OWUI template in a real question MUST NOT be
    // dropped. The pattern requires the header at the START of the
    // prompt; anywhere else stays a user question.
    const real =
      "Pourquoi Open WebUI envoie-t-il ce template:\n" +
      "### Task:\nGenerate a title\n" +
      "### Output:\nJSON format: { ... }\n" +
      "### Chat History:\n<chat_history>USER: x\nASSISTANT: y</chat_history>\n" +
      "à chaque fin de tour, et comment puis-je désactiver ça ?";
    const v = heuristicRoute({ query: real });
    assert.notEqual(v.route, "NONE");
  });
});

describe("heuristicRoute — CLI trivial pings", () => {
  it("skips 'test de bon fonctionnement' from cli", () => {
    const v = heuristicRoute({
      query: "Test de bon fonctionnement",
      isCli: true,
    });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_short");
  });

  it("skips 'ping' from cli", () => {
    assert.equal(heuristicRoute({ query: "ping", isCli: true }).route, "NONE");
    assert.equal(heuristicRoute({ query: "hello", isCli: true }).route, "NONE");
    assert.equal(heuristicRoute({ query: "salut", isCli: true }).route, "NONE");
  });

  it("does NOT skip the same prompt when not from cli", () => {
    // A real collaborator typing 'test' should still go through the
    // classifier, not be silently dropped.
    const v = heuristicRoute({ query: "test", isCli: false });
    assert.notEqual(v.route, "NONE");
  });

  it("does NOT skip a long prompt from cli", () => {
    const v = heuristicRoute({
      query: "compare the changelog of v3.1.0 and v3.2.0",
      isCli: true,
    });
    assert.notEqual(v.route, "NONE");
  });
});

describe("heuristicRoute — keyword fast-paths", () => {
  it("routes to PGVECTOR_ONLY on 'version'", () => {
    const v = heuristicRoute({ query: "quelle est la version d'OpenClaw de Jerome ?" });
    assert.equal(v.route, "PGVECTOR_ONLY");
    assert.equal(v.reason, "heuristic_keyword");
  });

  it("routes to PGVECTOR_ONLY on a file name with extension", () => {
    const v = heuristicRoute({
      query: "ouvre HANDOFF-TRAEFIK-MIGRATION-2026-05-11.md",
    });
    assert.equal(v.route, "PGVECTOR_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'compare'", () => {
    const v = heuristicRoute({
      query: "compare les méthodes pédagogiques de 2024 et 2026",
    });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'audit'", () => {
    const v = heuristicRoute({ query: "fait un audit complet de la stack" });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("routes to LIGHTRAG_ONLY on 'synthèse'", () => {
    const v = heuristicRoute({
      query: "synthèse des feedbacks coach sur la mission",
    });
    assert.equal(v.route, "LIGHTRAG_ONLY");
  });

  it("returns null route when nothing matches", () => {
    const v = heuristicRoute({
      query: "rappelle-moi ce qu'on a discuté hier",
    });
    assert.equal(v.route, null);
    assert.equal(v.reason, "classifier_fallback");
  });
});

describe("heuristicRoute — priority ordering", () => {
  it("trigger gating beats meta-agent regex", () => {
    const v = heuristicRoute({
      query: "session id?",
      trigger: "heartbeat",
    });
    assert.equal(v.reason, "heuristic_trigger");
  });

  it("meta-agent beats CLI-trivial when both would match", () => {
    // 'ping' matches BOTH the meta-agent regex (status / ping question)
    // AND the CLI-trivial pattern. Rule order in `heuristicRoute` is:
    //   1. trigger gating
    //   2. meta-agent regex   <-- fires here
    //   3. CLI-trivial
    // so the reason must be `heuristic_meta` (deterministic, documented).
    const v = heuristicRoute({ query: "ping", isCli: true });
    assert.equal(v.route, "NONE");
    assert.equal(v.reason, "heuristic_meta");
  });
});
