#!/usr/bin/env node
// Runs the test suite with a clean environment.
//
// The plugin's own SessionStart hook exports CODEX_COMPANION_SESSION_ID and
// CLAUDE_PLUGIN_DATA into every shell inside a Claude Code session, so `npm test`
// run from there would otherwise pick up a real per-workspace state directory and
// fail four tests that assert the temp-backed default. Clearing the variables in
// this process means the suite and every command it spawns agree on where state
// lives, whatever the surrounding shell looks like.
//
// A wrapper rather than `env -u` (not portable to Windows) or `--import`
// (requires Node 20.6+, while this package supports 18.18).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const AMBIENT_SESSION_VARS = ["CODEX_COMPANION_SESSION_ID", "CLAUDE_PLUGIN_DATA"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error("No test files found in tests/.");
  process.exit(1);
}

const env = { ...process.env };
for (const key of AMBIENT_SESSION_VARS) {
  delete env[key];
}

const result = spawnSync(process.execPath, ["--test", ...files, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit"
});

process.exit(result.status ?? 1);
