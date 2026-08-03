#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { summarizeGate } from "./review-triage.mjs";

function parseArgs(argv) {
  const values = new Set([
    "findings",
    "verifications",
    "iteration",
    "max-iterations",
    "previous-blocking",
    "suite-status",
    "blocking-output"
  ]);
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--") && values.has(arg.slice(2))) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readJson(file, label) {
  const target = path.resolve(process.cwd(), file);
  if (!fs.existsSync(target)) {
    throw new Error(`${label} not found: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function lineRange(entry) {
  if (!entry.line_start) {
    return "";
  }
  return entry.line_end && entry.line_end !== entry.line_start
    ? `:${entry.line_start}-${entry.line_end}`
    : `:${entry.line_start}`;
}

function render(gate) {
  const lines = [
    "# Verified Code Review Gate",
    "",
    `Iteration: ${gate.iteration} of ${gate.maxIterations}`,
    `Decision: ${gate.done ? "done" : gate.escalate ? `escalate (${gate.reason})` : "keep going"}`,
    `Repository suite: ${gate.suiteStatus}`,
    ""
  ];
  const sections = [
    ["Blocking", gate.blocking],
    ["Reported (non-blocking)", gate.reported],
    ["Dismissed (refuted)", gate.dismissed],
    ["Fixed", gate.resolved],
    ["Needs a human decision", gate.humanFlags]
  ];
  for (const [heading, entries] of sections) {
    if (entries.length === 0) {
      continue;
    }
    lines.push(`${heading}:`);
    for (const entry of entries) {
      const location = entry.file ? ` (${entry.file}${lineRange(entry)})` : "";
      lines.push(`- ${entry.title}${location} — ${entry.reason ?? ""}`.trimEnd());
      if (entry.evidence) {
        lines.push(`  Evidence: ${entry.evidence}`);
      }
    }
    lines.push("");
  }
  if (gate.nits.length > 0) {
    lines.push("Nits:", ...gate.nits.map((entry) => `- ${entry.title} (${entry.file}${lineRange(entry)})`));
    if (gate.nitOverflow > 0) {
      lines.push(`- plus ${gate.nitOverflow} similar items`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.findings) {
    throw new Error("Provide --findings <path>.");
  }
  const raw = readJson(options.findings, "Findings file");
  const findings = Array.isArray(raw) ? raw : raw?.result?.findings ?? raw?.findings;
  if (!Array.isArray(findings)) {
    throw new Error("Findings file must contain a findings array.");
  }
  const verifications = options.verifications ? readJson(options.verifications, "Verifications file") : {};
  const previousBlocking = options["previous-blocking"]
    ? readJson(options["previous-blocking"], "Previous blocking file")
    : undefined;
  const suiteStatus = options["suite-status"];
  if (suiteStatus && !["pass", "fail", "unknown"].includes(suiteStatus.toLowerCase())) {
    throw new Error("--suite-status must be pass, fail, or unknown.");
  }

  const gate = summarizeGate(findings, verifications, {
    iteration: options.iteration,
    maxIterations: options["max-iterations"],
    previousBlocking,
    suiteStatus
  });
  if (options["blocking-output"]) {
    fs.writeFileSync(path.resolve(process.cwd(), options["blocking-output"]), `${JSON.stringify(gate.blockingKeys, null, 2)}\n`);
  }
  process.stdout.write(options.json ? `${JSON.stringify(gate, null, 2)}\n` : render(gate));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
