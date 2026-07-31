---
summary: "Run OpenClaw as a self-contained ACP agent"
read_when:
  - Setting up an ACP client or IDE
  - Running OpenClaw from Buzz or another ACP host
  - Debugging ACP sessions, tools, or permissions
title: "ACP"
---

`openclaw acp` runs OpenClaw as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent over stdio.

The command is self-contained:

```text
ACP host <-> openclaw acp <-> embedded OpenClaw agent runtime
                                  |
                                  +-> local tools and canonical sessions
```

It does not connect to, start, or require an OpenClaw Gateway. The ACP process loads the normal OpenClaw configuration, runs model turns and tools in-process, and stores sessions through the canonical OpenClaw session APIs.

## Prerequisites

1. Install OpenClaw.
2. Configure and authenticate the provider and model you want OpenClaw to use.
3. Configure your ACP host to launch `openclaw acp`.

Use the normal [`openclaw onboard`](/start/getting-started) or [`openclaw configure`](/cli/configure) flow for provider authentication. ACP hosts with terminal-auth support can launch the model-only `openclaw acp --configure-model` flow advertised by the agent. ACP hosts do not need a Gateway URL, Gateway token, or separately managed OpenClaw service.

## Usage

```bash
openclaw acp

# Use a specific canonical OpenClaw session
openclaw acp --session agent:main:main

# Resolve an existing session by label
openclaw acp --session-label "support inbox" --require-existing

# Start a new lifecycle for the selected canonical session
openclaw acp --session agent:main:main --reset-session
```

The command writes ACP JSON-RPC messages to stdout. Logs and diagnostics go to stderr so they do not corrupt the protocol stream.

ACP hosts can detect this self-contained runtime contract without starting a session:

```bash
openclaw acp info
```

The command prints versioned JSON describing the ACP protocol, stdio transport, and embedded execution model. Older Gateway-backed OpenClaw releases do not expose this command, so hosts can fail closed instead of launching the wrong architecture.

## What this is not

`openclaw acp` is the inbound ACP surface: another application launches OpenClaw as its agent.

This is different from [ACP agents](/tools/acp-agents), where OpenClaw launches an external harness such as Codex or Claude Code through ACPX:

- ACP host launches OpenClaw: `openclaw acp`
- OpenClaw launches an external ACP harness: `/acp spawn` and [ACP agents](/tools/acp-agents)

The [Buzz](/channels/buzz) channel plugin is also a different integration. That plugin connects an already-running OpenClaw Gateway to Buzz as a channel. Buzz's first-class ACP runtime instead launches `openclaw acp` directly.

## Protocol support

| ACP area                                                          | Status      | Notes                                                                                                                                |
| ----------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `initialize`, `session/new`, `session/prompt`, `session/cancel`   | Implemented | Prompts run through the embedded OpenClaw agent runtime.                                                                             |
| `session/list`, `session/load`, `session/resume`, `session/close` | Implemented | Sessions use canonical OpenClaw storage and bounded list pagination.                                                                 |
| Text, embedded resources, and images                              | Implemented | Text and resources become prompt text; images become agent attachments.                                                              |
| Agent text and thought streaming                                  | Implemented | Model output is emitted as ACP session updates.                                                                                      |
| Tool streaming                                                    | Partial     | Tool calls, updates, text, raw I/O, and best-effort file locations are exposed. Embedded ACP terminals and structured diffs are not. |
| Session modes and config options                                  | Partial     | OpenClaw exposes supported thinking, verbosity, trace, reasoning, usage, elevated, fast-mode, and timeout controls.                  |
| Session info and usage                                            | Partial     | Session metadata is canonical; usage is approximate and has no cost data.                                                            |
| Permission requests                                               | Implemented | Tool approvals are requested directly from the connected ACP host.                                                                   |
| Per-session MCP servers                                           | Unsupported | Configure tools and MCP integrations in OpenClaw instead.                                                                            |
| ACP client filesystem and terminal methods                        | Unsupported | OpenClaw tools execute locally without calling ACP client `fs/*` or `terminal/*` methods.                                            |

## Sessions

Every ACP session has an immutable public ACP session ID and maps to one canonical OpenClaw session key.

By default, `session/new` creates a unique canonical session. Select an existing session with `--session`, `--session-label`, or ACP metadata:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "requireExisting": true,
    "resetSession": false
  }
}
```

An ACP session ID cannot later be rebound to a different canonical session key. Create or select another ACP session instead. Resetting a canonical session invalidates sibling ACP bindings to the previous lifecycle.

`session/load` replays the durable ACP event ledger when available. Older sessions without a complete ledger fall back to recent user and assistant transcript messages.

Learn more about canonical session keys at [Sessions](/concepts/session).

## Permissions

OpenClaw sends tool approval requests to the ACP host with `session/request_permission`. The host decides whether to allow or reject each request.

The interactive debug client auto-approves only a narrow allowlist of trusted read-only operations. Unknown tools, mutation, command execution, control-plane actions, out-of-scope reads, and interactive flows require explicit approval.

An unattended ACP host may choose a broader policy. Treat that host's identity and machine access as a security boundary.

## Buzz

Buzz can launch OpenClaw as a first-class ACP runtime with:

```text
command: openclaw
args: acp
```

Complete normal OpenClaw provider authentication before selecting the runtime in Buzz. When model authentication is missing, Buzz can launch OpenClaw's model-only configuration flow from the runtime setup screen. Buzz passes its dedicated agent environment to the ACP child process, so local OpenClaw tools inherit `BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, and related context. There is no separate Gateway process to configure or copy credentials into.

Each Buzz agent must use a dedicated Buzz identity. Never reuse a human owner or administrator private key.

Buzz currently answers ACP permission requests automatically with the `allow_once` option when one is offered. Because OpenClaw tools can execute commands and access local files, keep the agent owner-only unless you have deliberately constrained its tools and audience.

## Interactive client

Use the built-in client to test OpenClaw without an IDE:

```bash
openclaw acp client

# Choose the ACP session working directory
openclaw acp client --cwd /path/to/project

# Run a checkout directly
openclaw acp client \
  --server node \
  --server-args openclaw.mjs acp
```

`openclaw acp client` sets `OPENCLAW_SHELL=acp-client` on the spawned agent process for context-specific shell or profile rules.

## Zed setup

Add OpenClaw as a custom agent in Zed:

```json
{
  "agent_servers": {
    "OpenClaw": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

To use a specific canonical session, add `--session` and the session key to `args`.

## Options

- `--session <key>`: default canonical session key.
- `--session-label <label>`: default existing session label to resolve.
- `--require-existing`: fail if the selected key or label does not exist.
- `--reset-session`: reset the selected canonical session before first use.
- `--configure-model`: run the model authentication flow and exit.
- `--no-prefix-cwd`: do not prefix prompts with the working directory.
- `--provenance <off|meta|meta+receipt>`: attach ACP provenance metadata or a prompt receipt.
- `--verbose, -v`: write verbose diagnostics to stderr.

### `acp client` options

- `--cwd <dir>`: working directory for the ACP session.
- `--server <command>`: ACP server command, defaulting to `openclaw`.
- `--server-args <args...>`: arguments passed to the ACP server.
- `--server-verbose`: enable verbose logging on the ACP server.
- `--verbose, -v`: enable verbose client logging.

## Protocol smoke test

A useful stdio smoke test should:

1. Start `openclaw acp` without a Gateway.
2. Send `initialize`.
3. Send `session/new` with an absolute `cwd`.
4. Send `session/prompt`.
5. Observe model and tool session updates plus a terminal stop reason.
6. Close stdin and verify the process and active turns stop cleanly.

Setting `OPENCLAW_GATEWAY_URL` to an unreachable address should not affect this path. The ACP process has no inbound Gateway dependency.

## Related

- [CLI reference](/cli)
- [ACP agents](/tools/acp-agents)
- [Buzz](/channels/buzz)
- [Sessions](/concepts/session)
