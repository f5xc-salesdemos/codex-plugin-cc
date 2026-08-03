import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(
  ROOT,
  "plugins",
  "verified-review",
  "skills",
  "verified-code-review",
  "scripts",
  "gate-review.mjs"
);
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
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

test("shared gate blocks an unverified high-severity finding", () => {
  const cwd = makeTempDir();
  writeJson(cwd, "findings.json", { verdict: "needs-attention", findings: [CRITICAL] });

  const result = run("node", [SCRIPT, "--findings", "findings.json", "--json"], { cwd });

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.done, false);
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.blocking[0].status, "NOT_VERIFIED");
});

test("shared gate completes only after findings are settled and the suite passes", () => {
  const cwd = makeTempDir();
  writeJson(cwd, "findings.json", { verdict: "needs-attention", findings: [CRITICAL] });
  writeJson(cwd, "verify.json", {
    "src/session.js:2:Authorization bypass": {
      status: "REFUTED",
      evidence: "src/router.js:18 rejects every non-owner before this call"
    }
  });

  const result = run(
    "node",
    [
      SCRIPT,
      "--findings",
      "findings.json",
      "--verifications",
      "verify.json",
      "--suite-status",
      "pass",
      "--json"
    ],
    { cwd }
  );

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.done, true);
  assert.equal(gate.dismissed.length, 1);
});

test("shared gate carries a vanished blocker into the next iteration", () => {
  const cwd = makeTempDir();
  writeJson(cwd, "findings.json", []);
  writeJson(cwd, "verify.json", {});
  writeJson(cwd, "previous.json", ["src/session.js:2:Authorization bypass"]);

  const result = run(
    "node",
    [
      SCRIPT,
      "--findings",
      "findings.json",
      "--verifications",
      "verify.json",
      "--previous-blocking",
      "previous.json",
      "--iteration",
      "2",
      "--json"
    ],
    { cwd }
  );

  assert.equal(result.status, 0, result.stderr);
  const gate = JSON.parse(result.stdout);
  assert.equal(gate.blocking.length, 1);
  assert.equal(gate.reason, "no-progress");
  assert.equal(gate.escalate, true);
});

test("shared gate fails closed on malformed findings JSON", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "findings.json"), "{not json");

  const result = run("node", [SCRIPT, "--findings", "findings.json"], { cwd });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not valid JSON/i);
});
