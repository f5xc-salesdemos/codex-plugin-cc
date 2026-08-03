---
name: verified-code-review
description: Review specs, plans, and local code before human review or a pull-request push; verify every automated finding against the repository, then use an evidence-based gate and repeat until no confirmed critical or high finding remains
---

# Verified Code Review

Treat the automated reviewer as a second opinion, not an oracle. Review, verify, and gate in that
order. Change code only when a finding survives verification against the repository.

## Resolve the skill root

Set `<skill-root>` to the directory containing this `SKILL.md`. Use only the bundled scripts below;
do not substitute a platform-native reviewer or construct a provider command yourself.

Store review artifacts under `.code-review/` and add that directory to `.gitignore`. Findings may
quote source code and must not become part of the next review target.

## Run the review

Run a document review before asking a human to review a spec or implementation plan:

```bash
mkdir -p .code-review
node "<skill-root>/scripts/run-review.mjs" document \
  --file docs/spec.md --kind spec > .code-review/findings-1.json
```

Use `--kind plan` for an implementation plan. Run a branch review before a pull-request push:

```bash
node "<skill-root>/scripts/run-review.mjs" code \
  --base origin/main > .code-review/findings-1.json
```

Omit `--base` to review staged, unstaged, and untracked work. The adapter is always read-only.
Do not claim the review ran if the adapter exits unsuccessfully or returns malformed output.

## Verify every finding

Use the branch below that matches the reviewed artifact. Record one entry per finding in
`.code-review/verify-<iteration>.json`, keyed by `<file>:<line_start>:<title>`.

### Document findings

1. Read the whole document, not only the cited lines. If the supposedly missing requirement is
   elsewhere, mark the finding `REFUTED` and quote it.
2. Check the repository when a finding claims the document contradicts current behavior. A
   `CONFIRMED` contradiction requires `file:line` evidence.
3. Confirm a gap only when an implementer would have to guess and different guesses would produce
   materially different work. Record the ambiguous text and both outcomes.

Document findings require quoted evidence, not a test.

### Code findings

Check each finding in order and stop at the first decisive result:

1. Location: verify the file and cited lines contain the described behavior. Otherwise mark it
   `REFUTED` with the actual location evidence.
2. Reachability: inspect callers, types, schemas, and guards. If they prevent the failure, mark it
   `REFUTED` and cite the guard.
3. Reproduction: write a test or run a command that fails because of the finding. Mark it
   `CONFIRMED` only with the failing output as `testEvidence`; otherwise mark it `UNVERIFIED`.

Never confirm a code finding from reasoning alone. A convincing explanation is not executed
evidence.

Example verification file:

```json
{
  "src/session.js:2:Missing owner check": {
    "status": "CONFIRMED",
    "testEvidence": "npm test -- session (red: expected true, got false)"
  },
  "src/retry.js:4:Unbounded backoff": {
    "status": "REFUTED",
    "evidence": "src/index.js:34 enforces attempt <= MAX_ATTEMPTS"
  }
}
```

After fixing a confirmed finding and proving the test is green, retain `status: CONFIRMED`, add
`resolved: true`, and replace `testEvidence` with evidence that records both red and green results.

## Gate the loop

Run the deterministic gate rather than computing severity or completion manually:

```bash
node "<skill-root>/scripts/gate-review.mjs" \
  --findings .code-review/findings-1.json \
  --verifications .code-review/verify-1.json \
  --suite-status pass \
  --iteration 1 --max-iterations 3 \
  --blocking-output .code-review/blocking-1.json --json
```

From iteration 2 onward, add:

```bash
--previous-blocking .code-review/blocking-1.json
```

The gate carries earlier blockers forward. A finding disappearing from a later model response is
not proof that it was fixed.

| Reviewer severity | Result | Blocking |
| --- | --- | --- |
| `critical`, `high` + `CONFIRMED` | high | yes, until resolved with test evidence |
| `critical`, `high` + `UNVERIFIED` | medium + human flag | no |
| `medium` | medium | no |
| `low` | nit | no |
| missing or unknown | high | yes, fail closed |
| any severity + `REFUTED` | dismissed | no |
| critical/high without verification | high | yes, process failure |

Repeat review → verify → gate until `done` is true. That requires no blocking findings and a passing
repository test suite. Fix only confirmed blockers, one at a time, with a failing test first.

Stop and hand the result to the human when `escalate` is true. Do not raise the iteration cap.

## Report

Report:

- confirmed findings and the evidence or fix for each;
- refuted findings and their refutation evidence;
- unverified critical or high findings that need human judgment;
- the gate decision and any escalation reason.

Do not call a review clean when findings were dismissed. “Two findings, both refuted” and “no
findings” are different outcomes.
