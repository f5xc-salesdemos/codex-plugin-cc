# Codex delegation plugin for Claude Code

Use Codex from Claude Code for complex implementation, debugging, investigation, and session handoff.

This plugin intentionally does not provide code-review commands, review hooks, or review skills. The
F5 sales-demo fleet routes semantic code review to Antigravity instead of Claude or Codex.

## What You Get

- `/codex:rescue` delegates a substantial task to Codex.
- `/codex:transfer` imports the current Claude session into a Codex thread.
- `/codex:status`, `/codex:result`, and `/codex:cancel` manage delegated jobs.
- `/codex:setup` checks the local Codex CLI and authentication state.

## Requirements

- Claude Code with plugin support
- Codex CLI installed and authenticated
- Node.js 18.18 or later

Codex usage contributes to your Codex usage limits. Use the plugin for tasks that benefit from its
deeper reasoning or implementation capabilities; keep routine automation in Antigravity.

## Install

Add the marketplace and install the plugin in Claude Code:

```text
/plugin marketplace add f5-sales-demo/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
```

Then check the runtime:

```text
/codex:setup
```

If Codex is not authenticated, run `!codex login` (or the device/API-key login variant appropriate
for the environment).

## Usage

### Delegate complex work

```text
/codex:rescue investigate the intermittent deployment failure and implement the verified root-cause fix
/codex:rescue --background migrate this subsystem and update its focused tests
/codex:rescue --model gpt-5.4-mini --effort medium diagnose this concurrency failure
```

The rescue command uses the `codex:codex-rescue` subagent as a thin forwarder. If neither `--model`
nor `--effort` is supplied, Codex chooses its configured defaults. The `spark` alias maps to
`gpt-5.3-codex-spark`.

Use `--resume` to continue the latest Codex task associated with the current Claude session, or
`--fresh` to force a new thread:

```text
/codex:rescue --resume apply the next fix
/codex:rescue --fresh investigate an unrelated failure
```

### Transfer a session

```text
/codex:transfer
```

The command imports the current Claude transcript into Codex and returns a session ID plus a
`codex resume <session-id>` command.

### Manage background jobs

```text
/codex:status
/codex:status <job-id> --wait
/codex:result <job-id>
/codex:cancel <job-id>
```

Jobs are scoped to the current Claude session by default. Supplying an explicit job ID can address a
known job from another session in the same workspace.

## Runtime and sandboxing

The first task lazily starts a shared Codex app-server broker for the workspace. Later commands reuse
that broker. Session lifecycle hooks clean up jobs and the shared runtime when the Claude session ends.

Read-only tasks use the `read-only` sandbox. Write-capable rescue tasks request `workspace-write`.
`CODEX_COMPANION_SANDBOX` can replace the read-only sandbox on hosts that cannot start the normal OS
sandbox; it never changes a write-capable task's requested access.

## Development

```bash
npm install
npm test
npm run check-version
```

`npm run prebuild` regenerates app-server protocol types from the installed Codex CLI, and
`npm run build` validates the protocol wrapper with TypeScript.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
