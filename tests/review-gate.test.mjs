import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import { parseStructuredOutput } from "../plugins/codex/scripts/lib/codex.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

const CRITICAL = {
  severity: "critical",
  title: "Authorization bypass",
  body: "Only the first owner is checked.",
  file: "src/session.js",
  line_start: 2,
  line_end: 2,
  confidence: 0.9,
  recommendation: "Check every owner."
};

function writeJson(dir, name, value) {
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
  return name;
}

test("review-gate requires findings", () => {
  const dir = makeTempDir();
  const result = run("node", [SCRIPT, "review-gate"], { cwd: dir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--findings/);
});

test("review-gate blocks on a confirmed critical finding", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", [CRITICAL]);
  writeJson(dir, "verify.json", {
    "Authorization bypass": { status: "CONFIRMED", testEvidence: "npm test -- session (red)" }
  });

  const result = run("node", [SCRIPT, "review-gate", "--findings", "findings.json", "--verifications", "verify.json", "--json"], {
    cwd: dir
  });

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.done, false);
  assert.equal(gate.blocking.length, 1);
});

test("review-gate clears once the confirmed finding is refuted", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", [CRITICAL]);
  writeJson(dir, "verify.json", {
    "Authorization bypass": { status: "REFUTED", evidence: "src/index.js:12 bounds the value" }
  });

  const result = run(
    "node",
    [SCRIPT, "review-gate", "--findings", "findings.json", "--verifications", "verify.json", "--suite-status", "pass", "--json"],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.done, true);
  assert.equal(gate.dismissed.length, 1);
});

test("review-gate will not declare done while the repository suite is unproven", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", []);

  const result = run("node", [SCRIPT, "review-gate", "--findings", "findings.json", "--json"], { cwd: dir });

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.findingsClear, true);
  assert.equal(gate.done, false);
  assert.equal(gate.reason, "suite-status-unknown");
});

test("review-gate rejects an unrecognized suite status", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", []);

  const result = run("node", [SCRIPT, "review-gate", "--findings", "findings.json", "--suite-status", "probably"], {
    cwd: dir
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--suite-status/);
});

test("review-gate accepts a whole review payload, not just a findings array", () => {
  const dir = makeTempDir();
  writeJson(dir, "review.json", { result: { verdict: "needs-attention", findings: [CRITICAL] } });
  writeJson(dir, "verify.json", {
    "Authorization bypass": { status: "CONFIRMED", testEvidence: "red" }
  });

  const result = run("node", [SCRIPT, "review-gate", "--findings", "review.json", "--verifications", "verify.json", "--json"], {
    cwd: dir
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).blocking.length, 1);
});

test("review-gate renders refuted findings with their evidence so a wrong review is visible", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", [CRITICAL]);
  writeJson(dir, "verify.json", {
    "Authorization bypass": { status: "REFUTED", evidence: "src/index.js:12 bounds the value" }
  });

  const result = run("node", [SCRIPT, "review-gate", "--findings", "findings.json", "--verifications", "verify.json"], {
    cwd: dir
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dismissed \(refuted/i);
  assert.match(result.stdout, /src\/index\.js:12 bounds the value/);
});

test("review-gate exits non-zero on malformed findings rather than reading as clean", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "broken.json"), "{not json");

  const result = run("node", [SCRIPT, "review-gate", "--findings", "broken.json"], { cwd: dir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/i);
});

test("review-gate exits non-zero when the findings file has no findings array", () => {
  const dir = makeTempDir();
  writeJson(dir, "odd.json", { unrelated: true });

  const result = run("node", [SCRIPT, "review-gate", "--findings", "odd.json"], { cwd: dir });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /findings array/i);
});

test("review-gate escalates when the iteration cap is exceeded", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", [CRITICAL]);
  writeJson(dir, "verify.json", {
    "Authorization bypass": { status: "CONFIRMED", testEvidence: "red" }
  });

  const result = run(
    "node",
    [
      SCRIPT,
      "review-gate",
      "--findings",
      "findings.json",
      "--verifications",
      "verify.json",
      "--iteration",
      "4",
      "--max-iterations",
      "3",
      "--json"
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.escalate, true);
  assert.equal(gate.reason, "max-iterations");
});

test("parseStructuredOutput unwraps a fenced JSON payload", () => {
  const fenced = ["```json", JSON.stringify({ verdict: "approve", findings: [] }), "```"].join("\n");

  const parsed = parseStructuredOutput(fenced);

  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.rawOutput, fenced, "the raw output should be preserved verbatim");
});

test("parseStructuredOutput still reports genuinely unparseable output", () => {
  const parsed = parseStructuredOutput("Codex could not complete the review.");

  assert.equal(parsed.parsed, null);
  assert.ok(parsed.parseError);
});

test("a carried-forward finding that was fixed is not reported as refuted", () => {
  const dir = makeTempDir();
  writeJson(dir, "findings.json", []);
  writeJson(dir, "verify.json", {
    "src/session.js:3:Missing owner check": {
      status: "CONFIRMED",
      resolved: true,
      testEvidence: "red before, green after"
    }
  });
  writeJson(dir, "blocking.json", ["src/session.js:3:Missing owner check"]);

  const result = run(
    "node",
    [
      SCRIPT,
      "review-gate",
      "--findings",
      "findings.json",
      "--verifications",
      "verify.json",
      "--previous-blocking",
      "blocking.json",
      "--iteration",
      "2",
      "--suite-status",
      "pass"
    ],
    { cwd: dir }
  );

  assert.equal(result.status, 0, result.stderr);
  // Codex was right and the defect was fixed. Calling that "refuted" would corrupt the
  // signal the human uses to judge how much to trust the reviewer.
  assert.doesNotMatch(result.stdout, /Dismissed \(refuted/i);
  assert.match(result.stdout, /Fixed/i);
  assert.doesNotMatch(result.stdout, /\(null\)/, "carried-forward entries have no file to render");
});
