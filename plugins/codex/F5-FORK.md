# F5 fork notes

`f5-sales-demo/codex-plugin-cc` is a fork of `openai/codex-plugin-cc`. This file records what
diverges from upstream, why, and how to keep the fork syncable. Read it before merging an
upstream release.

## Versioning

Version numbers are fork-owned. `1.0.7` and later are F5 releases that do not correspond to an
upstream tag. When syncing upstream, keep the fork version ahead of the upstream version so the
Claude Code installer always sees a newer release.

**Every change that must reach installed plugins bumps the version in its own pull request.**
The plugin cache is keyed by version, so merging a fix without a bump leaves the installer
resolving to a directory that may already hold the pre-fix code — the change becomes
undeliverable rather than merely delayed.

## Divergences from upstream

### Read-only review sandbox (`resolveSandbox`)

`plugins/codex/scripts/lib/codex.mjs` defaults every thread to the `read-only` sandbox and
resolves an optional `CODEX_COMPANION_SANDBOX` override. `plugins/codex/scripts/codex-companion.mjs`
and `runAppServerReview` pass `DEFAULT_SANDBOX` instead of the hardcoded `danger-full-access`.

This **restores** upstream's original behavior. Fork commit `59d2a85` had replaced `read-only`
with `danger-full-access` globally to work around bubblewrap being unable to mount devpts in a
nested Linux container. That fixed one Linux-container symptom by removing OS isolation for
every user on every platform, and it silently falsified three "this command is read-only"
statements in `README.md`. The env var names the environment constraint instead of hiding it,
and only ever substitutes for `read-only` so it cannot widen or narrow a write-capable run.

**Known gap:** the override was verified on macOS (Apple Seatbelt) only. macOS Seatbelt is not
Linux bubblewrap, so the Linux nested-container path that motivates the override is
**unverified**. If a container user reports a failure, reproduce it there and record the result
here. Related upstream discussion: `openai/codex-plugin-cc#18`. Prefer upstreaming
`resolveSandbox` over carrying it — upstream's own default was already `read-only`.

Verified on macOS 25.3.0, `codex-cli 0.145.0`, against the F5 LiteLLM gateway:

| Path | Sandbox sent | Can write? |
|---|---|---|
| `adversarial-review`, `review`, `review-doc` | `read-only` | no (`touchedFiles: []`) |
| `task` without `--write` | `read-only` | no |
| `task --write` | `workspace-write` | yes |
| any review with `CODEX_COMPANION_SANDBOX=danger-full-access` | `danger-full-access` | yes |
| `CODEX_COMPANION_SANDBOX=<invalid>` | — | hard error |

**What read-only does and does not buy.** It prevents the reviewer from modifying the tree it
is judging. It does **not** stop Codex from executing commands, reaching the network
(`web_search = "live"` in `config.toml`), or reading anything the user can read. So it is not by
itself sufficient for docs-control `REVIEWER-SPEC.md` invariant 3 (untrusted PR content must
never be executed and secrets must never be exfiltrated). That invariant governs the CI reviewer,
which faces third-party pull requests; this local layer reviews the engineer's own branch before
a pull request exists. Do not describe read-only as satisfying invariant 3.

The per-thread sandbox parameter overrides `sandbox_mode` in `~/.codex/config.toml`: with
`sandbox_mode = "danger-full-access"` set globally, `codex exec --sandbox read-only` was still
blocked from writing.

### Test fixture records thread parameters

`tests/fake-codex-fixture.mjs` records `state.lastThreadStart` and `state.lastThreadResume`
(`cwd`, `model`, `sandbox`, `approvalPolicy`, `ephemeral`) and adds `outputSchema` to
`state.lastTurnStart`. `sandbox` is a thread parameter, not a turn parameter, so without this
no test can assert on it. Note the fixture's thread/start *response* uses a different shape
(`{type: "readOnly"}`) — do not copy that when asserting on request parameters.

## Gateway compatibility (F5 LiteLLM, `wire_api = "responses"`)

Verified working against `https://f5ai.pd.f5net.com/openai/v1` with `model = gpt-5.6-sol`:

- `turn/start` with `outputSchema` returns schema-conforming JSON (`parseError: null`).
- `review/start` (the native reviewer) works, but produces markedly weaker output than
  `adversarial-review` — on identical input it reported "no clear regression or actionable bug"
  where the adversarial path found a high-severity authorization defect. Prefer
  `adversarial-review` for anything that gates work.
- `codex login status` reports "Not logged in" because auth comes from `OPENAI_API_KEY` via the
  `litellm` provider in `config.toml`. `detectApiKeyAuth()` handles this; `/codex:setup`
  correctly reports ready.

## After every merge to `main`

The plugin cache is keyed by version, so a new skill or command will not load until the version
changes **and** the install is refreshed:

1. `npm run bump-version <next>` && `npm run check-version`
2. `/plugin marketplace update openai-codex`, then update/reinstall `codex@openai-codex`
3. Verify `installPath` in `~/.claude/plugins/installed_plugins.json` ends in the new version
4. Verify the new skill or command appears in a **fresh** Claude Code session

Step 4 is the only sufficient check. Steps 1–3 are necessary but not sufficient.

## Known upstream issues worth fixing

- `npm test` is not hermetic against `CODEX_COMPANION_SESSION_ID` and `CLAUDE_PLUGIN_DATA`.
  Running the suite inside a Claude Code session with this plugin enabled fails 4 tests,
  because the plugin's own SessionStart hook exports both variables. CI is unaffected. Clear
  them (`env -u CODEX_COMPANION_SESSION_ID -u CLAUDE_PLUGIN_DATA npm test`) or fix the tests to
  isolate the environment.
- `parseStructuredOutput` is a bare `JSON.parse` and never validates against
  `schemas/review-output.schema.json`. Consumers must treat a missing or unrecognized
  `severity` as blocking rather than trusting the field to be present.
