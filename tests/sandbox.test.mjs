import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

// A repository with one committed file and one uncommitted edit, so every review
// scope (working tree, branch, native) has something to look at.
function makeReviewableRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  return repo;
}

test("adversarial review runs Codex in a read-only sandbox", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "read-only");
});

test("native review runs Codex in a read-only sandbox", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "read-only");
});

test("a task without --write runs Codex in a read-only sandbox", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "summarize the diff"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "read-only");
});

test("a task with --write keeps its workspace-write sandbox", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--write", "fix the bug"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "workspace-write");
});

test("CODEX_COMPANION_SANDBOX relaxes a read-only review for hosts that cannot sandbox", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_SANDBOX: "danger-full-access" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "danger-full-access");
});

test("CODEX_COMPANION_SANDBOX never rewrites a write-capable run", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "task", "--write", "fix the bug"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_SANDBOX: "read-only" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFakeState(binDir).lastThreadStart.sandbox, "workspace-write");
});

test("an unrecognized CODEX_COMPANION_SANDBOX value fails loudly", () => {
  const repo = makeReviewableRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: { ...buildEnv(binDir), CODEX_COMPANION_SANDBOX: "yolo" }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CODEX_COMPANION_SANDBOX/);
});
