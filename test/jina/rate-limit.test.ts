// Tests for the Jina RPM soft monitor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RPM_BUDGET, RpmMonitor } from "../../src/jina/rate-limit.js";

describe("RpmMonitor — sliding-window counting", () => {
  it("returns the running count post-record", () => {
    const mon = new RpmMonitor({ budget: 100, now: () => 1_000_000 });
    assert.equal(mon.record(), 1);
    assert.equal(mon.record(), 2);
    assert.equal(mon.record(), 3);
  });

  it("drops timestamps older than 60 seconds", () => {
    let nowMs = 1_000_000;
    const mon = new RpmMonitor({ budget: 100, now: () => nowMs });
    mon.record(); // t=0
    mon.record(); // t=0
    nowMs += 30_000;
    mon.record(); // t=30s
    nowMs += 31_000;
    // t=61s — first two should have expired (>60s old).
    assert.equal(mon.record(), 2);
  });

  it("peek does not record a request", () => {
    const mon = new RpmMonitor({ budget: 100, now: () => 1_000_000 });
    mon.record();
    mon.record();
    assert.equal(mon.peek(), 2);
    assert.equal(mon.peek(), 2);
    assert.equal(mon.record(), 3);
  });

  it("DEFAULT_RPM_BUDGET is 60", () => {
    assert.equal(DEFAULT_RPM_BUDGET, 60);
  });
});

describe("RpmMonitor — overshoot callback", () => {
  it("fires onExceeded the FIRST time the budget is overshot", () => {
    const calls: Array<{ count: number; budget: number }> = [];
    const mon = new RpmMonitor({
      budget: 3,
      onExceeded: (info) => calls.push(info),
      now: () => 1_000_000,
    });
    mon.record(); // 1
    mon.record(); // 2
    mon.record(); // 3 — at budget, NOT over
    assert.equal(calls.length, 0);
    mon.record(); // 4 — overshoot
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { count: 4, budget: 3 });
  });

  it("does not fire again within the same 60-second window after the first overshoot", () => {
    let nowMs = 1_000_000;
    const calls: number[] = [];
    const mon = new RpmMonitor({
      budget: 1,
      onExceeded: (info) => calls.push(info.count),
      now: () => nowMs,
    });
    mon.record(); // 1
    mon.record(); // 2 — first overshoot fires
    mon.record(); // 3 — still in same window, NO duplicate fire
    nowMs += 30_000;
    mon.record(); // 4 — still in same window, NO duplicate fire
    assert.equal(calls.length, 1);
  });

  it("fires AGAIN once 60s have passed since the previous notice", () => {
    let nowMs = 1_000_000;
    const calls: number[] = [];
    const mon = new RpmMonitor({
      budget: 1,
      onExceeded: (info) => calls.push(info.count),
      now: () => nowMs,
    });
    mon.record(); // 1
    mon.record(); // 2 — first notice
    assert.equal(calls.length, 1);
    nowMs += 61_000;
    // Old records have expired by now, so we need 2 fresh records to overshoot again.
    mon.record(); // 1 (fresh window)
    mon.record(); // 2 — second notice fires
    assert.equal(calls.length, 2);
  });

  it("does not crash when onExceeded is omitted", () => {
    const mon = new RpmMonitor({ budget: 1, now: () => 1_000_000 });
    mon.record();
    assert.doesNotThrow(() => mon.record());
  });
});

describe("RpmMonitor — bound checks", () => {
  it("defaults to DEFAULT_RPM_BUDGET when budget is omitted", () => {
    const calls: number[] = [];
    const mon = new RpmMonitor({
      onExceeded: (info) => calls.push(info.budget),
      now: () => 1_000_000,
    });
    // Push beyond the default — assert the budget value reported in the
    // callback matches the constant.
    for (let i = 0; i < DEFAULT_RPM_BUDGET + 1; i++) mon.record();
    assert.equal(calls[0], DEFAULT_RPM_BUDGET);
  });
});

describe("RpmMonitor — disabled mode (budget <= 0)", () => {
  it("budget=0 disables recording AND alerting (Codex pass #33 P2)", () => {
    // Codex pass #33 P2 regression: with budget=0, the legacy comparison
    // `count > 0` was true on the first record, firing an erroneous
    // overshoot alert on every plugin turn. The "disabled" contract
    // documented on JinaPluginConfig.rpmBudget MUST hold: zero records,
    // zero callbacks.
    const calls: Array<{ count: number; budget: number }> = [];
    const mon = new RpmMonitor({
      budget: 0,
      onExceeded: (info) => calls.push(info),
      now: () => 1_000_000,
    });

    for (let i = 0; i < 200; i++) {
      assert.equal(mon.record(), 0, "record() must return 0 when disabled");
    }
    assert.equal(calls.length, 0, "onExceeded must NEVER fire when disabled");
    assert.equal(mon.peek(), 0, "peek() must return 0 when disabled");
  });

  it("negative budget is also treated as disabled (defense-in-depth)", () => {
    const calls: number[] = [];
    const mon = new RpmMonitor({
      budget: -10,
      onExceeded: (info) => calls.push(info.count),
      now: () => 1_000_000,
    });
    for (let i = 0; i < 50; i++) mon.record();
    assert.equal(calls.length, 0);
    assert.equal(mon.peek(), 0);
  });

  it("fires the first overshoot even with a clock that starts at 0 (Codex pass #34 P3)", () => {
    // Codex pass #34 P3 regression: a deterministic test clock starting
    // at `now=0` would previously suppress the first alert during the
    // first 60 simulated seconds, because `lastExceededNotice` was
    // initialized to 0 and the dedup check `t - 0 >= 60_000` was
    // unsatisfiable until simulated time reached 60s.
    let nowMs = 0;
    const calls: Array<{ count: number; budget: number }> = [];
    const mon = new RpmMonitor({
      budget: 2,
      onExceeded: (info) => calls.push(info),
      now: () => nowMs,
    });
    mon.record(); // 1
    mon.record(); // 2 — at budget, no fire
    mon.record(); // 3 — overshoot MUST fire even though now=0
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { count: 3, budget: 2 });
  });
});
