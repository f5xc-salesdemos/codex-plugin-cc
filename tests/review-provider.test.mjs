import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(
  ROOT,
  "plugins",
  "verified-review",
  "skills",
  "verified-code-review",
  "scripts",
  "run-review.mjs"
);

const APPROVAL = {
  verdict: "approve",
  summary: "No material findings.",
  findings: [],
  next_steps: []
};

function installFakeReviewer(binDir, output = APPROVAL, providerStatus = "SUCCESS") {
  const executable = path.join(binDir, process.platform === "win32" ? "agy.cmd" : "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_REVIEW_STATE, JSON.stringify({
  args: process.argv.slice(2),
  tokens: {
    GH_TOKEN: process.env.GH_TOKEN ?? null,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,
    REPO_SETTINGS_TOKEN: process.env.REPO_SETTINGS_TOKEN ?? null,
    REPO_SYNC_TOKEN: process.env.REPO_SYNC_TOKEN ?? null
  }
}));
process.stdout.write(JSON.stringify({
  status: ${JSON.stringify(providerStatus)},
  response: ${JSON.stringify(JSON.stringify(output))}
}));
`;
  writeExecutable(executable, source);
}

function reviewerEnv(binDir, stateFile) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_REVIEW_STATE: stateFile,
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    REPO_SETTINGS_TOKEN: "secret",
    REPO_SYNC_TOKEN: "secret"
  };
}

test("document review runs the provider sandboxed, read-only, and without GitHub credentials", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const stateFile = path.join(cwd, "state.json");
  fs.writeFileSync(path.join(cwd, "spec.md"), "# Design\n\nDOCUMENT_SENTINEL\n");
  installFakeReviewer(binDir);

  const result = run("node", [SCRIPT, "document", "--file", "spec.md", "--kind", "spec"], {
    cwd,
    env: reviewerEnv(binDir, stateFile)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), APPROVAL);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(state.tokens, {
    GH_TOKEN: null,
    GITHUB_TOKEN: null,
    REPO_SETTINGS_TOKEN: null,
    REPO_SYNC_TOKEN: null
  });
  assert.ok(state.args.includes("--sandbox"));
  assert.deepEqual(state.args.slice(state.args.indexOf("--mode"), state.args.indexOf("--mode") + 2), [
    "--mode",
    "plan"
  ]);
  assert.ok(state.args.includes("--disable-slash-commands"));
  assert.deepEqual(
    state.args.slice(state.args.indexOf("--output-format"), state.args.indexOf("--output-format") + 2),
    ["--output-format", "json"]
  );
  assert.ok(!state.args.includes("--dangerously-skip-permissions"));
  const prompt = state.args.at(-1);
  assert.match(prompt, /DOCUMENT_SENTINEL/);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /valid JSON/i);
});

test("code review sends an explicit merge-base range to the provider", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const stateFile = path.join(cwd, "state.json");
  installFakeReviewer(binDir);
  assert.equal(run("git", ["init", "-b", "main"], { cwd }).status, 0);
  assert.equal(run("git", ["config", "user.name", "Review Test"], { cwd }).status, 0);
  assert.equal(run("git", ["config", "user.email", "review@example.com"], { cwd }).status, 0);
  fs.writeFileSync(path.join(cwd, "file.txt"), "base\n");
  assert.equal(run("git", ["add", "file.txt"], { cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "base"], { cwd }).status, 0);
  assert.equal(run("git", ["switch", "-c", "feature"], { cwd }).status, 0);
  fs.appendFileSync(path.join(cwd, "file.txt"), "change\n");
  assert.equal(run("git", ["commit", "-am", "change"], { cwd }).status, 0);

  const result = run("node", [SCRIPT, "code", "--base", "main"], {
    cwd,
    env: reviewerEnv(binDir, stateFile)
  });

  assert.equal(result.status, 0, result.stderr);
  const prompt = JSON.parse(fs.readFileSync(stateFile, "utf8")).args.at(-1);
  const baseSha = run("git", ["rev-parse", "main"], { cwd }).stdout.trim();
  const headSha = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  assert.match(prompt, new RegExp(`${baseSha}\\.\\.\\.${headSha}`));
  assert.match(prompt, /git diff --find-renames/);
  assert.match(prompt, /do not edit|read-only/i);
});

test("review adapter fails closed on malformed structured output", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const stateFile = path.join(cwd, "state.json");
  fs.writeFileSync(path.join(cwd, "plan.md"), "# Plan\n");
  installFakeReviewer(binDir, { verdict: "approve", findings: [] });

  const result = run("node", [SCRIPT, "document", "--file", "plan.md", "--kind", "plan"], {
    cwd,
    env: reviewerEnv(binDir, stateFile)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /structured review output|next_steps|summary/i);
});

test("review adapter fails closed when the provider envelope reports failure", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const stateFile = path.join(cwd, "state.json");
  fs.writeFileSync(path.join(cwd, "plan.md"), "# Plan\n");
  installFakeReviewer(binDir, APPROVAL, "FAILED");

  const result = run("node", [SCRIPT, "document", "--file", "plan.md", "--kind", "plan"], {
    cwd,
    env: reviewerEnv(binDir, stateFile)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not complete successfully.*FAILED/i);
});
