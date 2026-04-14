# Security Policy

中文摘要：如果你发现了 `codex-thread-relay-mcp` 在 relay、dispatch、callback、lease、状态持久化或 app-server 会话上的安全问题，请不要在公开 issue 里直接贴 exploit。

## Supported Versions

This repository currently supports security fixes on:

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Older commits or forks | No |

## In-Scope Reports

Please report issues that could affect:

- trusted-project filtering
- thread resolution and wrong-target delivery
- lease ownership and concurrent dispatch safety
- async callback delivery and retry state
- state file integrity, path traversal, or unsafe file writes
- unintended access to threads, projects, or local Codex state
- secret leakage through logs, callbacks, or MCP responses

## Preferred Reporting Path

1. Use GitHub private vulnerability reporting for this repository when that option is available.
2. If that option is unavailable, open a minimal issue that asks for a private reporting path.
3. Do not post exploit payloads, local machine paths, tokens, thread ids, or full callback envelopes publicly.

## What To Include

Please include:

- affected tool or workflow
- exact relay command shape
- expected behavior
- observed behavior
- impact and affected trust boundary
- smallest safe reproduction
- whether the issue depends on same-project nesting, timeout, busy state, or recovery

## Response Expectations

The maintainer aims to:

- acknowledge receipt within 5 business days
- classify whether the issue is valid and in scope
- coordinate a fix, mitigation, or safe workaround before public disclosure when possible

## Disclosure Guidance

Please allow time for coordinated remediation before publishing exploit details or broad reproduction steps.
