import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins", "verified-review");
const SKILL = path.join(PLUGIN, "skills", "verified-code-review", "SKILL.md");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

test("one provider-neutral verified-code-review skill serves Claude and Codex", () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, "plugins", "codex", "skills", "verified-code-review", "SKILL.md")),
    false,
    "the historical Claude-only skill copy must be removed"
  );

  const skill = fs.readFileSync(SKILL, "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  assert.match(frontmatter, /^name: verified-code-review$/m);
  assert.match(frontmatter, /^description: .+$/m);
  assert.equal(frontmatter.split("\n").length, 2, "portable skill frontmatter has only name and description");
  assert.doesNotMatch(skill, /\bCodex\b/);
  assert.doesNotMatch(skill, /\bAntigravity\b|\bagy\b/i);
  assert.match(skill, /review.*verify.*gate.*loop/is);
  assert.match(skill, /scripts\/run-review\.mjs/);
  assert.match(skill, /scripts\/gate-review\.mjs/);

  const claudeManifest = readJson("plugins/verified-review/.claude-plugin/plugin.json");
  const codexManifest = readJson("plugins/verified-review/.codex-plugin/plugin.json");
  assert.equal(claudeManifest.name, "verified-review");
  assert.equal(codexManifest.name, "verified-review");

  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
  const claudeEntry = claudeMarketplace.plugins.find((entry) => entry.name === "verified-review");
  assert.equal(claudeEntry?.source, "./plugins/verified-review");

  const codexMarketplace = readJson(".agents/plugins/marketplace.json");
  const codexEntry = codexMarketplace.plugins.find((entry) => entry.name === "verified-review");
  assert.equal(codexEntry?.source?.path, "./plugins/verified-review");
  assert.equal(codexEntry?.policy?.installation, "AVAILABLE");
  assert.equal(codexEntry?.policy?.authentication, "ON_INSTALL");
});

test("the provider adapter is the only shared-plugin file coupled to agy", () => {
  const coupled = [];
  const pending = [path.join(PLUGIN, "skills", "verified-code-review")];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, file.name);
      if (file.isDirectory()) {
        pending.push(absolute);
      } else if (/\bagy\b|Antigravity/i.test(fs.readFileSync(absolute, "utf8"))) {
        coupled.push(path.relative(PLUGIN, absolute));
      }
    }
  }

  coupled.sort();
  assert.deepEqual(coupled, ["skills/verified-code-review/scripts/run-review.mjs"]);
});

test("installation docs expose the shared skill to both Claude and Codex", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /plugin install verified-review@openai-codex/);
  assert.match(readme, /codex plugin marketplace add/);
  assert.match(readme, /codex plugin add verified-review@f5-sales-demo-verified-review/);
  assert.match(readme, /same `verified-code-review` skill source/i);
});
