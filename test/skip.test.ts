// Unit tests for the 4.0 pre-router skip stage and the acknowledgement filter.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../src/config.js";
import { isAcknowledgement, ACK_MAX_LENGTH } from "../src/router/heuristic.js";
import { evaluateSkip } from "../src/skip.js";

const skip = resolveConfig({ lightragUrl: "http://lr:9621" }).skip;

describe("evaluateSkip — sessions", () => {
  it("skips sessions_spawn children (:subagent:)", () => {
    const v = evaluateSkip(skip, { sessionKey: "agent:olivier:subagent:abc123" }, "what is the plan?");
    assert.equal(v?.reason, "skip_subagent_session");
    assert.equal(v?.detail, ":subagent:");
  });

  it("skips the active-memory recall sub-agent session", () => {
    const v = evaluateSkip(
      skip,
      { sessionKey: "agent:olivier:main:active-memory:0123456789ab" },
      "recall the project status",
    );
    assert.equal(v?.reason, "skip_subagent_session");
  });

  it("does not skip an ordinary direct session", () => {
    assert.equal(
      evaluateSkip(skip, { sessionKey: "agent:olivier:telegram:direct:42", trigger: "user" }, "project status?"),
      null,
    );
  });

  it("honours custom sessionPatterns", () => {
    const custom = resolveConfig({ lightragUrl: "x", skip: { sessionPatterns: [":cron-job:"] } }).skip;
    assert.equal(evaluateSkip(custom, { sessionKey: "agent:a:subagent:x" }, "question here"), null);
    assert.equal(
      evaluateSkip(custom, { sessionKey: "agent:a:cron-job:x" }, "question here")?.reason,
      "skip_subagent_session",
    );
  });
});

describe("evaluateSkip — triggers", () => {
  for (const trigger of ["heartbeat", "cron", "memory", "manual"]) {
    it(`skips trigger=${trigger} with the legacy reason name`, () => {
      const v = evaluateSkip(skip, { trigger }, "some question text");
      assert.equal(v?.reason, "heuristic_trigger");
      assert.equal(v?.detail, trigger);
    });
  }

  it("does not skip trigger=user", () => {
    assert.equal(evaluateSkip(skip, { trigger: "user" }, "some question text"), null);
  });

  it("skip.triggers=[] disables trigger skipping", () => {
    const none = resolveConfig({ lightragUrl: "x", skip: { triggers: [] } }).skip;
    assert.equal(evaluateSkip(none, { trigger: "heartbeat" }, "some question text"), null);
  });
});

describe("evaluateSkip — input provenance", () => {
  it("skips inter_session input (sessions_send / subagent announce)", () => {
    const v = evaluateSkip(
      skip,
      { trigger: "user", inputProvenance: { kind: "inter_session", sourceTool: "subagent_announce" } },
      "the child finished its task",
    );
    assert.equal(v?.reason, "skip_non_human_input");
    assert.equal(v?.detail, "inter_session:subagent_announce");
  });

  it("skips internal_system input (background wakes)", () => {
    const v = evaluateSkip(
      skip,
      { inputProvenance: { kind: "internal_system", sourceTool: "exec_approval_followup" } },
      "command completed",
    );
    assert.equal(v?.reason, "skip_non_human_input");
  });

  it("keeps external_user input (including voice transcripts)", () => {
    assert.equal(
      evaluateSkip(
        skip,
        { inputProvenance: { kind: "external_user", sourceTool: "gateway.voice.transcript" } },
        "what is on my agenda",
      ),
      null,
    );
  });

  it("treats ABSENT provenance as human (legacy behavior)", () => {
    assert.equal(evaluateSkip(skip, { trigger: "user" }, "what is on my agenda"), null);
  });

  it("allowSourceTools re-admits a specific non-human source", () => {
    const cfg = resolveConfig({
      lightragUrl: "x",
      skip: { allowSourceTools: ["session_goal_resume"] },
    }).skip;
    assert.equal(
      evaluateSkip(
        cfg,
        { inputProvenance: { kind: "internal_system", sourceTool: "session_goal_resume" } },
        "continue the goal",
      ),
      null,
    );
  });

  it("nonHumanInput=false disables provenance skipping", () => {
    const cfg = resolveConfig({ lightragUrl: "x", skip: { nonHumanInput: false } }).skip;
    assert.equal(
      evaluateSkip(cfg, { inputProvenance: { kind: "inter_session" } }, "hello there friend"),
      null,
    );
  });
});

describe("evaluateSkip — acknowledgements", () => {
  it("flags acknowledgements on every channel", () => {
    assert.equal(evaluateSkip(skip, { messageProvider: "telegram" }, "merci !")?.reason, "heuristic_ack");
    assert.equal(evaluateSkip(skip, { messageProvider: "webchat" }, "ok parfait")?.reason, "heuristic_ack");
  });

  it("skip.acknowledgements=false keeps them", () => {
    const cfg = resolveConfig({ lightragUrl: "x", skip: { acknowledgements: false } }).skip;
    assert.equal(evaluateSkip(cfg, {}, "merci"), null);
  });
});

describe("isAcknowledgement", () => {
  const positives = [
    "merci",
    "Merci !",
    "merci beaucoup 🙏",
    "ok",
    "OK parfait",
    "oui vas-y",
    "Vas-y",
    "parfait.",
    "super merci",
    "d'accord",
    "D’accord 👍",
    "top",
    "bonjour",
    "Salut !",
    "thanks!",
    "Thank you so much",
    "great",
    "go ahead",
    "ok merci 👍🏻",
    "c'est bon",
    "ça marche",
    "non",
    "no",
    "hello :)",
    "noted.",
    "bien reçu",
  ];
  const negatives = [
    "merci de me donner le budget du projet Hélios",
    "ok, quel est le statut du projet ACME ?",
    "oui mais qui est le client ?",
    "bonjour, peux-tu me résumer la réunion de lundi ?",
    "non pas ça, cherche le contrat",
    "top 5 des clients",
    "hi there, what's the version?",
    "okay so what now?",
    "thanks, and the invoice?",
    "notebook",
    "okapi",
    "",
  ];
  for (const q of positives) {
    it(`ack: ${JSON.stringify(q)}`, () => assert.equal(isAcknowledgement(q), true));
  }
  for (const q of negatives) {
    it(`not ack: ${JSON.stringify(q)}`, () => assert.equal(isAcknowledgement(q), false));
  }

  it("is length-bounded and linear on hostile input", () => {
    const hostile = "ok ".repeat(10_000) + "?";
    const started = Date.now();
    assert.equal(isAcknowledgement(hostile), false);
    assert.equal(isAcknowledgement("merci ".repeat(ACK_MAX_LENGTH)), false);
    assert.ok(Date.now() - started < 50);
  });
});
