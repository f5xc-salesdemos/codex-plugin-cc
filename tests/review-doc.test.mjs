import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

const SPEC = [
  "# Session expiry design",
  "",
  "PROBE_SPEC_SENTINEL",
  "",
  "Sessions expire after 30 minutes. The worker sweeps expired sessions hourly.",
  ""
].join("\n");

function writeSpec(dir, name = "spec.md") {
  const specPath = path.join(dir, name);
  fs.writeFileSync(specPath, SPEC);
  return specPath;
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

test("review-doc requires a document to review", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "review-doc"], { cwd: dir, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--file/);
});

test("review-doc fails clearly when the document does not exist", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "missing.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\.md/);
});

test("review-doc runs outside a git repository", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  assert.equal(fs.existsSync(path.join(dir, ".git")), false);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
});

test("review-doc sends the document body and the review schema to Codex", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.match(state.lastTurnStart.prompt, /PROBE_SPEC_SENTINEL/);
  assert.ok(state.lastTurnStart.outputSchema, "expected an output schema to be attached");
  assert.ok(state.lastTurnStart.outputSchema.properties.verdict, "expected the review schema");
});

test("review-doc uses the document prompt, not the code-diff adversarial prompt", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = readFakeState(binDir).lastTurnStart.prompt;
  assert.match(prompt, /document review/i);
  assert.doesNotMatch(prompt, /adversarial software review/);
});

test("review-doc reviews a plan with the requested kind", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir, "plan.md");

  const result = run("node", [SCRIPT, "review-doc", "--file", "plan.md", "--kind", "plan"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFakeState(binDir).lastTurnStart.prompt, /implementation plan/i);
  assert.match(result.stdout, /Plan Review/i);
});

test("review-doc rejects an unknown kind", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md", "--kind", "novella"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /spec|plan/i);
});

test("review-doc runs Codex in a read-only sandbox", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "read-only");
});

test("review-doc emits the parsed structured result with --json", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md", "--json"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.parseError, null);
  assert.ok(["approve", "needs-attention"].includes(payload.result.verdict));
  assert.equal(payload.review, "Spec Review");
});

test("review-doc renders findings most severe first", () => {
  const dir = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  writeSpec(dir);

  const result = run("node", [SCRIPT, "review-doc", "--file", "spec.md"], {
    cwd: dir,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const criticalAt = result.stdout.indexOf("Missing rollback path");
  const lowAt = result.stdout.indexOf("Vague rollout wording");
  assert.ok(criticalAt >= 0, `expected the critical finding in output:\n${result.stdout}`);
  assert.ok(lowAt >= 0, `expected the low finding in output:\n${result.stdout}`);
  assert.ok(criticalAt < lowAt, "expected the critical finding to render before the nit");
});
