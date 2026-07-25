import test from "node:test";
import assert from "node:assert/strict";

import { classifyFinding, mapSeverity, summarizeGate } from "../plugins/codex/scripts/lib/review-triage.mjs";

function finding(overrides = {}) {
  return {
    severity: "critical",
    title: "Authorization bypass",
    body: "Only the first owner is checked.",
    file: "src/session.js",
    line_start: 2,
    line_end: 2,
    confidence: 0.9,
    recommendation: "Check every owner.",
    ...overrides
  };
}

const CONFIRMED = { status: "CONFIRMED", testEvidence: "npm test -- session (red)" };
const REFUTED = { status: "REFUTED", evidence: "src/index.js:12 already bounds the value" };
const UNVERIFIED = { status: "UNVERIFIED", evidence: "no reachable caller found" };

test("Codex severities map onto the fleet's three tiers", () => {
  assert.equal(mapSeverity("critical"), "high");
  assert.equal(mapSeverity("high"), "high");
  assert.equal(mapSeverity("medium"), "medium");
  assert.equal(mapSeverity("low"), "low");
});

test("an unrecognized or missing severity is treated as blocking", () => {
  assert.equal(mapSeverity("catastrophic"), "high");
  assert.equal(mapSeverity(undefined), "high");
  assert.equal(mapSeverity(null), "high");
  assert.equal(mapSeverity(""), "high");

  const classified = classifyFinding(finding({ severity: undefined }), CONFIRMED);
  assert.equal(classified.fleetSeverity, "high");
  assert.equal(classified.blocking, true);
});

test("a refuted finding does not block and keeps its refutation evidence", () => {
  const classified = classifyFinding(finding(), REFUTED);
  assert.equal(classified.blocking, false);
  assert.equal(classified.status, "REFUTED");
  assert.match(classified.reason, /refuted/i);
  assert.equal(classified.evidence, REFUTED.evidence);
});

test("an unverified critical is demoted to medium and flagged for a human", () => {
  const classified = classifyFinding(finding(), UNVERIFIED);
  assert.equal(classified.blocking, false);
  assert.equal(classified.fleetSeverity, "medium");
  assert.equal(classified.humanFlag, true);
});

test("a finding nobody verified blocks, because skipping verification is not a pass", () => {
  const classified = classifyFinding(finding(), undefined);
  assert.equal(classified.blocking, true);
  assert.match(classified.reason, /not verified/i);
});

test("a confirmed critical without a fix blocks the gate", () => {
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, { iteration: 1 });
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.done, false);
});

test("a confirmed critical is done only once it is resolved with a test", () => {
  const resolved = { status: "CONFIRMED", testEvidence: "npm test -- session (green)", resolved: true };
  const gate = summarizeGate([finding()], { "Authorization bypass": resolved }, { iteration: 2, suiteStatus: "pass" });
  assert.equal(gate.blocking.length, 0);
  assert.equal(gate.done, true);
});

test("claiming a fix without a test still blocks", () => {
  const noTest = { status: "CONFIRMED", resolved: true, testEvidence: null };
  const gate = summarizeGate([finding()], { "Authorization bypass": noTest }, { iteration: 2 });
  assert.equal(gate.blocking.length, 1);
  assert.match(gate.blocking[0].reason, /without a test/i);
  assert.equal(gate.done, false);
});

test("a review with no findings is done", () => {
  const gate = summarizeGate([], {}, { iteration: 1, suiteStatus: "pass" });
  assert.equal(gate.done, true);
  assert.equal(gate.escalate, false);
});

test("medium and low findings are reported without blocking", () => {
  const findings = [finding({ severity: "medium", title: "Narrow error path" }), finding({ severity: "low", title: "Naming" })];
  const gate = summarizeGate(findings, {
    "Narrow error path": CONFIRMED,
    Naming: CONFIRMED
  }, { iteration: 1, suiteStatus: "pass" });

  assert.equal(gate.blocking.length, 0);
  assert.equal(gate.reported.length, 1);
  assert.equal(gate.nits.length, 1);
  assert.equal(gate.done, true);
});

test("nits are capped at five with an overflow count", () => {
  const findings = Array.from({ length: 8 }, (_, index) =>
    finding({ severity: "low", title: `Nit ${index}` })
  );
  const verifications = Object.fromEntries(findings.map((f) => [f.title, CONFIRMED]));

  const gate = summarizeGate(findings, verifications, { iteration: 1, suiteStatus: "pass" });
  assert.equal(gate.nits.length, 5);
  assert.equal(gate.nitOverflow, 3);
  assert.equal(gate.done, true);
});

test("an identical blocking set two iterations running escalates as no progress", () => {
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, {
    iteration: 2,
    previousBlocking: ["Authorization bypass"]
  });

  assert.equal(gate.escalate, true);
  assert.equal(gate.reason, "no-progress");
  assert.equal(gate.done, false);
});

test("a changed blocking set does not escalate as no progress", () => {
  const gate = summarizeGate([finding({ title: "Different defect" })], { "Different defect": CONFIRMED }, {
    iteration: 2,
    previousBlocking: ["Authorization bypass"]
  });

  assert.equal(gate.escalate, false);
  assert.equal(gate.reason, null);
});

test("the final permitted iteration escalates rather than starting another round", () => {
  // maxIterations: 3 must mean three review rounds, not four.
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, {
    iteration: 3,
    maxIterations: 3
  });

  assert.equal(gate.escalate, true);
  assert.equal(gate.reason, "max-iterations");
});

test("an earlier iteration with blockers keeps going", () => {
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, {
    iteration: 2,
    maxIterations: 3
  });

  assert.equal(gate.escalate, false);
  assert.equal(gate.done, false);
});

test("exceeding the iteration cap escalates to a human", () => {
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, {
    iteration: 4,
    maxIterations: 3
  });

  assert.equal(gate.escalate, true);
  assert.equal(gate.reason, "max-iterations");
  assert.equal(gate.done, false);
});

test("a clean review at the iteration cap is done, not escalated", () => {
  const gate = summarizeGate([], {}, { iteration: 3, maxIterations: 3, suiteStatus: "pass" });
  assert.equal(gate.done, true);
  assert.equal(gate.escalate, false);
});

test("a previously confirmed blocker that vanishes from a later review does not count as done", () => {
  // Iteration 2 simply does not mention the defect. Absence is not proof of a fix.
  const gate = summarizeGate([], {}, {
    iteration: 2,
    previousBlocking: ["Authorization bypass"]
  });

  assert.equal(gate.done, false);
  assert.equal(gate.blocking.length, 1);
  assert.match(gate.blocking[0].reason, /without a verified fix/i);
});

test("a previously confirmed blocker clears when this iteration proves the fix", () => {
  const gate = summarizeGate([], {
    "Authorization bypass": { status: "CONFIRMED", resolved: true, testEvidence: "npm test -- session (green)" }
  }, {
    iteration: 2,
    previousBlocking: ["Authorization bypass"],
    suiteStatus: "pass"
  });

  assert.equal(gate.done, true);
  assert.equal(gate.blocking.length, 0);
});

test("a previously confirmed blocker clears when this iteration refutes it", () => {
  const gate = summarizeGate([], {
    "Authorization bypass": { status: "REFUTED", evidence: "src/index.js:12 already guards this" }
  }, {
    iteration: 2,
    previousBlocking: ["Authorization bypass"],
    suiteStatus: "pass"
  });

  assert.equal(gate.done, true);
});

test("two findings sharing a title do not share one title-keyed verification", () => {
  const findings = [
    finding({ title: "Missing empty-state guard", file: "src/a.js", line_start: 4, line_end: 4 }),
    finding({ title: "Missing empty-state guard", file: "src/b.js", line_start: 9, line_end: 9 })
  ];

  // One ambiguous, title-only refutation must not silently dismiss both findings.
  const gate = summarizeGate(findings, {
    "Missing empty-state guard": { status: "REFUTED", evidence: "guarded in src/a.js" }
  }, { iteration: 1 });

  assert.equal(gate.dismissed.length, 0, "an ambiguous title-keyed verification must not be applied");
  assert.equal(gate.blocking.length, 2);
  assert.equal(gate.done, false);
});

test("findings sharing a title are verified individually by file and line", () => {
  const findings = [
    finding({ title: "Missing empty-state guard", file: "src/a.js", line_start: 4, line_end: 4 }),
    finding({ title: "Missing empty-state guard", file: "src/b.js", line_start: 9, line_end: 9 })
  ];

  const gate = summarizeGate(findings, {
    "src/a.js:4:Missing empty-state guard": { status: "REFUTED", evidence: "guarded at src/a.js:2" },
    "src/b.js:9:Missing empty-state guard": CONFIRMED
  }, { iteration: 1, suiteStatus: "pass" });

  assert.equal(gate.dismissed.length, 1);
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.blocking[0].file, "src/b.js");
});

test("a unique title still accepts a title-keyed verification", () => {
  const gate = summarizeGate([finding()], { "Authorization bypass": CONFIRMED }, { iteration: 1 });
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.blocking[0].status, "CONFIRMED");
});

test("malformed findings input is rejected rather than treated as clean", () => {
  assert.throws(() => summarizeGate(null, {}, { iteration: 1 }), /findings/i);
  assert.throws(() => summarizeGate("[]", {}, { iteration: 1 }), /findings/i);
  assert.throws(() => summarizeGate([{ title: "no severity field at all" }], {}, { iteration: 1 }), /file/i);
});

test("a clean findings list is not done while the repository suite is red", () => {
  const gate = summarizeGate([], {}, { iteration: 1, suiteStatus: "fail" });

  assert.equal(gate.findingsClear, true);
  assert.equal(gate.done, false);
  assert.match(gate.reason, /suite/i);
});

test("a clean findings list is not done while the suite status is unknown", () => {
  // Fail closed: nobody claimed the suite passes, so the loop cannot declare victory.
  const gate = summarizeGate([], {}, { iteration: 1 });

  assert.equal(gate.findingsClear, true);
  assert.equal(gate.done, false);
  assert.match(gate.reason, /suite/i);
});
