---
name: verified-code-review
description: Use before asking a human to review a spec or plan, before pushing a branch that will open a pull request, and after each round of fixes - runs a Codex second-opinion review, verifies every finding against the codebase, and loops until no confirmed critical or high finding remains
user-invocable: true
---

# Verified Code Review

Codex is a second opinion, not an oracle. It finds real defects that a single reviewer misses,
and it also reports defects that do not exist — misattributed to the wrong file, already
prevented by a caller-side guard, or simply inferred from a diff too narrow to judge. Both
happen often enough that neither "trust it" nor "ignore it" is a workable policy.

So this skill does three things in order: **review**, **verify**, **loop**. The verification
step is the reason the skill exists. A finding earns the right to change code by surviving a
check against the codebase — never by sounding convincing.

## When to run

1. A spec is written and self-reviewed, and you are about to ask the human to review it
   (`superpowers:brainstorming` checklist item 8).
2. An implementation plan is written by `superpowers:writing-plans` and you are about to hand
   it to the human.
3. You are about to push a branch that will open or update a pull request.
4. You have just finished a round of fixes from an earlier run of this skill.

At moments 1 and 2, run the review **before** the human ask, and present its verified results
alongside the document. The human should spend their attention on the judgment calls, not on
finding the gap that a machine could have found first.

## Invocations

Always through the companion script. Never hand-roll a Codex CLI string.

```bash
# A spec or plan document
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review-doc \
  --file docs/superpowers/specs/2026-01-01-topic-design.md --kind spec --json

# A branch that is about to become a pull request
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review \
  --base origin/main --json

# Uncommitted work
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --json
```

Rules:
- `--kind plan` for an implementation plan, `--kind spec` for a design document.
- Never use `task` for a review. That is the `codex:codex-rescue` path and it is write-capable.
- Never pass `--write` on any review path.
- Prefer `adversarial-review` over the native `review`. On identical input the native reviewer
  has reported "no clear regression or actionable bug" where the adversarial path found a
  high-severity authorization defect.
- Save each review's JSON to `.codex-review/findings-<iteration>.json`. Add `.codex-review/`
  to the repository's `.gitignore` if it is not already there: these files quote source code,
  and an untracked directory otherwise shows up as reviewable work in the *next* review.

## Verify every finding

Verification differs for code and for documents, because the two fail in different ways. Use
the branch that matches what you reviewed.

### Verifying a document finding (`review-doc`)

A document finding is usually about something **absent**: no rollback path, an untestable
acceptance criterion, a requirement that admits two readings. Absence is not located at a line
and cannot have a failing test, so the code checks below would wrongly refute every real one.
Instead:

**(a) Read the whole document, not just the cited lines.** Is the thing genuinely missing, or is
it specified somewhere the reviewer did not look? If it is specified elsewhere, the finding is
**REFUTED** — quote the text that specifies it.

**(b) If the finding claims the repository contradicts the document, check the repository.**
CONFIRMED requires the contradicting `file:line`; if the code actually agrees with the document,
the finding is **REFUTED**.

**(c) Ask whether an implementer would actually be blocked.** If the answer is genuinely "they
would have to guess, and guessing wrong costs real work", it is **CONFIRMED**, and the evidence
is the quoted gap plus what the two readings would produce. If it is a matter of taste or would
be settled by the first line of code, it is a nit, not a blocker.

Document findings never require a test to be CONFIRMED. They require a quotation.

### Verifying a code finding (`adversarial-review`)

Work through the findings one at a time. For each, run these checks in order and stop at the
first that settles it:

**(a) Location.** Does `finding.file` exist? Read `line_start..line_end`. If the file is absent,
or those lines do not contain what `body` describes, the finding is **REFUTED (misattributed)**.
Record what is actually at that location.

**(b) Reachability.** Grep for callers. Does the described failure actually reach that code, or
does a caller-side guard, type constraint, or schema already prevent it? If it is already
prevented, the finding is **REFUTED** — cite the guard's `file:line`.

**(c) Test.** Can you write a test that fails **today** because of this finding? If yes, it is
**CONFIRMED**, and that failing test is the evidence. If you cannot construct one, it is
**UNVERIFIED**.

**(d)** Apply the "From External Reviewers" checklist in `superpowers:receiving-code-review`.
That skill is the skepticism protocol; follow it rather than re-deriving it here.

**(e) Record** one row per finding in `.codex-review/verify-<iteration>.json`, keyed by
`<file>:<line_start>:<title>`:

```json
{
  "src/session.js:2:Missing owner check": {
    "status": "CONFIRMED",
    "testEvidence": "npm test -- session (red: expected true, got false)"
  },
  "src/retry.js:4:Unbounded exponential backoff": {
    "status": "REFUTED",
    "evidence": "src/index.js:34 enforces attempt <= MAX_ATTEMPTS (5); tests/retry.test.js passes"
  }
}
```

**Never mark a code finding CONFIRMED from reasoning alone.** CONFIRMED requires a failing test
or an executed command whose output you paste. An argument that a defect exists is not evidence
that it does. (Document findings are the exception noted above: their evidence is a quotation,
because you cannot write a failing test against a paragraph.)

Key each record by `<file>:<line_start>:<title>`. A bare title works only when that title is
unique in the review — the gate refuses to apply an ambiguous title-keyed record to more than
one finding, because the same defect class legitimately appears in two files.

Set `"resolved": true` on a finding once its fix has landed and its test passes. The gate
rejects `resolved` without `testEvidence`, so the test has to come first.

## Gate the loop

Do not hand-compute severities or decide "close enough" yourself:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review-gate \
  --findings .codex-review/findings-1.json \
  --verifications .codex-review/verify-1.json \
  --iteration 1 --max-iterations 3 --json
```

From iteration 2 onward, pass the previous iteration's `blockingKeys` so nothing is lost between
rounds:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review-gate \
  --findings .codex-review/findings-2.json \
  --verifications .codex-review/verify-2.json \
  --previous-blocking .codex-review/blocking-1.json \
  --suite-status pass \
  --iteration 2 --max-iterations 3 --json
```

A blocker that simply stops being reported is **not** treated as fixed. Reviews are not
deterministic — a finding can vanish because the diff moved or the model sampled differently —
so the gate carries each previous blocker forward until this iteration either proves the fix
(`resolved` plus `testEvidence`) or refutes it.

It maps Codex's four severities onto the fleet's three tiers, and a finding blocks **only when
CONFIRMED**:

| Codex severity | Fleet tier | Blocks? |
|---|---|---|
| `critical`, `high` | 🔴 high | Yes, if CONFIRMED and not yet resolved |
| `medium` | 🟠 medium | No — reported and counted |
| `low` | 🟡 nit | No — at most five, then "plus N similar items" |
| missing or unrecognized | 🔴 high | Yes — fail closed |
| any severity, REFUTED | dismissed | No — reported with its refutation evidence |
| critical/high, UNVERIFIED | 🟠 + human flag | No |
| any severity, never verified | 🔴 high | Yes — skipping verification is not a pass |

"Blocks only when CONFIRMED" is what makes the loop terminate. A hallucinated critical finding
cannot be fixed, because there is nothing there to fix; if it could block, the loop would never
end.

## Loop

Repeat review → verify → gate until the gate reports `done: true`, which requires all of:

1. No CONFIRMED critical or high finding remains outstanding.
2. Every CONFIRMED critical or high finding, from any iteration, has a fix and a test that was
   red before the fix and green after.
3. The repository's own test suite passes — pass `--suite-status pass` to say so. The gate
   will not report `done` on an unproven suite, because nobody claiming it passed is not the
   same as it passing.

Within an iteration, fix only CONFIRMED blocking findings, one at a time, failing test first
per `superpowers:test-driven-development`. Commit each fix separately.

The gate reports `findingsClear` separately from `done`, so a red suite is visible rather than
hidden behind a clean findings list.

Stop and hand the work to the human when the gate reports `escalate: true`:
- `max-iterations` — the last permitted round still had blocking findings. With
  `--max-iterations 3` that is iteration 3, not 4.
- `no-progress` — two consecutive iterations produced the same blocking findings.

Do not raise the cap to get past an escalation. An escalation means the loop is not converging,
and another round of the same thing will not change that.

## Report

Always show the human:
- the CONFIRMED findings and what was done about each;
- the **REFUTED findings with their refutation evidence** — when Codex was wrong, this is the
  only visible output of the verification pass, and it is how the human calibrates how much to
  trust this layer;
- any UNVERIFIED critical or high finding, called out as needing a human judgment call;
- the gate's decision and, on escalation, its reason.

Do not present a review as clean when findings were dismissed. "Two findings, both refuted"
and "no findings" are different results.

## Relationship to the other skills

- `codex-result-handling` — governs how Codex output is presented. Its "never auto-fix" rule
  holds everywhere except the narrow exception it grants this skill.
- `gpt-5-4-prompting` — review prompts live in `prompts/`. Do not hand-write them.
- `codex-cli-runtime` — the `codex:codex-rescue` contract. Not used here; reviews never go
  through `task`.
- `superpowers:receiving-code-review` — the skepticism protocol for external feedback.
- `superpowers:test-driven-development` — the failing-test-first requirement.

## When Codex is unavailable

Run `codex-companion.mjs setup --json`. If Codex is missing or not ready, say so once and
continue the work without the review. This layer is additive: it never blocks progress, and it
is not the merge gate.
