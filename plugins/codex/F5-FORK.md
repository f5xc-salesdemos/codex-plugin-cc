# F5 fork notes

`f5-sales-demo/codex-plugin-cc` is a fork of `openai/codex-plugin-cc`. This file records current
divergences from upstream and should be checked before importing an upstream release.

## Versioning

Version numbers are fork-owned. Every change that must reach installed plugins requires a version
bump because the Claude Code plugin cache is keyed by version.

## Fleet role

The fork exposes Codex only for complex implementation, debugging, investigation, and session
handoff. It intentionally omits upstream code-review commands and stop-time review gates. The F5
sales-demo fleet routes semantic review automation to Antigravity.

An upstream sync must not restore review commands, review hooks, review prompts, review schemas,
or review skills.

## Sandboxing

`plugins/codex/scripts/lib/codex.mjs` defaults tasks to the `read-only` sandbox and supports an
optional `CODEX_COMPANION_SANDBOX` override for hosts that cannot start the normal OS sandbox. The
override substitutes only for read-only runs; a write-capable task retains `workspace-write`.

| Path | Sandbox sent |
| --- | --- |
| `task` without `--write` | `read-only` |
| `task --write` | `workspace-write` |
| invalid override | hard error |

The per-thread sandbox parameter overrides `sandbox_mode` from the user configuration.

## Shared runtime

The fork lazily starts and reuses one app-server broker per workspace. Session lifecycle hooks clean
up jobs and the shared runtime. The fake Codex fixture records thread and turn parameters so tests
can verify sandbox, model, effort, and persistence behavior.

## Gateway compatibility

Gateway credentials use the neutral `GATEWAY_TOKEN` and `GATEWAY_URL` names. Do not restore the
deprecated F5-prefixed identifiers.

Provider-backed API-key authentication may make `codex login status` report logged out even while
the app server is ready. `detectApiKeyAuth()` handles that case for `/codex:setup`.

## After every merge to `main`

1. Run `npm run bump-version <next>` and `npm run check-version`.
2. Update or reinstall `codex@openai-codex` from the marketplace.
3. Confirm the installed path uses the new version.
4. Verify the commands in a fresh Claude Code session.

The fleet's managed Claude installations should not install this plugin unless complex Codex
delegation is explicitly required.
