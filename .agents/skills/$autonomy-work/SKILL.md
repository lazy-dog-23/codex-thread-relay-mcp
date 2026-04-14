---
name: autonomy-work
description: Pick one ready task, make the smallest change that satisfies it, verify and review the result, and stop.
---

# autonomy-work

Use this skill when you are executing a single ready task in a dedicated worktree.

## Responsibilities

- Read `autonomy/goal.md`, `autonomy/goals.json`, `autonomy/tasks.json`, `autonomy/state.json`, `autonomy/blockers.json`, and `autonomy/results.json`.
- Select exactly one `ready` task.
- Make the smallest possible change for that task.
- Run `scripts/verify.ps1` and then `scripts/review.ps1`.
- If verify and review pass and there is a diff, commit only on `codex/autonomy` with the autonomy commit format.
- Acquire `autonomy/locks/cycle.lock` before writing `autonomy/*`.
- Write `autonomy/*.json` via atomic temp-file then rename semantics.
- Update task status, review status, result summary, and append one journal entry.

## Guardrails

- Do not pick a second task in the same run.
- Do not push or deploy.
- Do not continue after a verification failure or real ambiguity.
- If the background worktree is dirty, set `review_pending` and stop.

## Failure handling

- First verification failure: mark the task `verify_failed` and increment `retry_count`.
- Second verification failure or a real ambiguity: mark the task `blocked` and add a blocker.
- Success: mark the task `done` and stop.
