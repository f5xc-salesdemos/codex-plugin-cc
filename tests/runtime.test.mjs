import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

test("setup reports a ready delegation runtime without review configuration", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.sessionRuntime.mode, "direct");
  assert.equal(Object.hasOwn(payload, "reviewGateEnabled"), false);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "task", "diagnose the deployment failure"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task forwards model and effort selection", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const result = run(
    "node",
    [SCRIPT, "task", "--model", "spark", "--effort", "low", "implement the migration"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(state.lastTurnStart.effort, "low");
});

test("task --resume continues the latest persisted task thread", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);

  const first = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior run/);

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.lastTurnStart.threadId, "thr_1");
  assert.equal(state.lastTurnStart.prompt, "follow up");
});

test("background task exposes status and stored result", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "implement the fix"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");

  const status = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.status, "completed");

  const result = run("node", [SCRIPT, "result", launchPayload.jobId], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task progress logs reasoning and assistant output", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");

  const result = run("node", [SCRIPT, "task", "investigate the failure"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Assistant message/);
});

test("deprecated review subcommands are unavailable", () => {
  for (const command of ["review", "adversarial-review", "review-doc", "review-gate"]) {
    const result = run("node", [SCRIPT, command], { cwd: ROOT });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Unknown subcommand: ${command}`));
  }
});

test("status and setup honor --cwd for shared runtime reporting", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();
  saveBrokerSession(targetWorkspace, { endpoint: "unix:/tmp/fake-broker.sock" });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).sessionRuntime.mode, "shared");
});
